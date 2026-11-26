//! The trunk's relay (CONTRACTS.md C4, spec §5.1/§5.7): many roots on one v1 trunk.
//!
//! * `WS /t/root` — each root dials out and proves its root key (proto 2 handshake); a v0.9
//!   bridge (no `X-Ygg-Proto: 2`) gets 426 `update this computer`. A newer link of the same root
//!   takes over from the older one.
//! * HTTP streams — a device's request goes to its door root as one mux stream (OPEN/DATA/CLOSE),
//!   the P12 law first (one request per connection, chunked → 411, conflicting Content-Length →
//!   400); the root's bridge applies the whole law again (ap.rs `serve_stream`).
//! * WireGuard — WG frames are relayed by address between online roots with wg.rs's shape checks;
//!   the source address is always the authenticated link's root id, never what the sender claimed.
//!   The trunk holds no WireGuard key: it moves handshakes and ciphertext only.
//! * ICE-TCP — a framed-STUN connection goes to the root that REGISTERED its receiver ufrag
//!   (`ice.register`, TTL 120 s, kept in memory only); an unknown ufrag is held up to 2 s for a
//!   late registration, then closed (`ice.unknown`). The newest registration of a ufrag wins.
//! * The directory — every root (id, name, wg_pub, wg_addr, dtls_fp, has_app, has_voice, online,
//!   peer_token_sha256), signed by the trunk key, pushed to every root on every change.
//! * Revoking a root — its link gets a signed `root.revoked` and is closed, its key is refused from
//!   then on (the registry says so), the directory without it goes to every other root: their wg
//!   nodes drop it at once (P13: ≤ 1.5 s).

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;

use crate::v1::proto::{self, DirRoot, SignKey};
use crate::v1::state::{now_ms, DenyEntry, Key};
use crate::v1::wsio::{self, Io, OP_BIN, OP_CLOSE, OP_PING, OP_PONG};
use crate::meter;

const SILENT: Duration = Duration::from_secs(45);
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// An unknown ufrag waits this long for a late registration (spec §5.7).
pub const ICE_HOLD: Duration = Duration::from_secs(2);
const ICE_TTL_MAX: u64 = 300;

/// One root as the trunk's registry (trunk.db `roots`) knows it.
#[derive(Debug, Clone, PartialEq)]
pub struct RootRec {
    pub id: String,
    pub name: String,
    pub root_pub: [u8; 32],
    pub wg_pub: String,
    pub wg_addr: String,
    pub dtls_fp: String,
    pub has_app: bool,
    pub has_voice: bool,
    pub peer_token_sha256: String,
    pub revoked: bool,
}

/// The roots registry (trunk.db; the tests keep one in memory).
pub trait Registry: Send + Sync {
    /// A root by id, revoked ones included (their key is refused with `revoked`).
    fn root(&self, id: &str) -> Option<RootRec>;
    /// Every root that is not revoked, in enrollment order (the directory, the door fallback).
    fn roots(&self) -> Vec<RootRec>;
    /// The root's link came up / is still up (last_seen).
    fn seen(&self, _id: &str, _now: u64) {}
}

/// What the roots must know of the identity side (the IDP owns it): the token keys, the kill
/// switch, the deny-list.
pub trait Authority: Send + Sync {
    fn token_keys(&self) -> Vec<Key>;
    fn kill(&self) -> (u64, bool);
    fn deny(&self) -> Vec<DenyEntry>;
}

type StreamTx = mpsc::UnboundedSender<Option<Vec<u8>>>;
type Frames = mpsc::UnboundedSender<(u8, Vec<u8>)>;

#[derive(Clone)]
struct RootLink {
    epoch: u64,
    out: Frames,
    streams: Arc<Mutex<HashMap<u32, StreamTx>>>,
    since: u64,
    peer: SocketAddr,
}

pub struct Hub {
    pub trunk_id: String,
    key: Arc<SignKey>,
    reg: Arc<dyn Registry>,
    auth: Arc<dyn Authority>,
    links: Mutex<HashMap<String, RootLink>>,
    gens: AtomicU64,
    ids: AtomicU32,
    /// ufrag → (root id, expires)
    ice: Mutex<HashMap<String, (String, Instant)>>,
    ice_changed: Notify,
    /// (seq, the signed directory, its content)
    dir: Mutex<(u64, Value, Vec<DirRoot>)>,
    /// the trunk's channel probes: id → the waiting probe's sender (answered by the root's CTRL echo)
    pending_probes: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<()>>>,
    /// the seq last pushed to every root
    pushed: AtomicU64,
    keys_seq: AtomicU64,
    /// tests: every WG payload the trunk relayed (to prove it only ever sees ciphertext)
    pub wg_tap: Mutex<Option<Vec<Vec<u8>>>>,
    pub wg_relayed: AtomicU64,
    pub wg_dropped: AtomicU64,
}

fn count(name: &str) {
    meter::inc_named(name);
}

impl Hub {
    pub fn new(trunk_id: &str, key: Arc<SignKey>, reg: Arc<dyn Registry>, auth: Arc<dyn Authority>) -> Arc<Hub> {
        Arc::new(Hub {
            trunk_id: trunk_id.to_string(),
            key,
            reg,
            auth,
            links: Mutex::default(),
            gens: AtomicU64::new(0),
            ids: AtomicU32::new(0),
            ice: Mutex::default(),
            ice_changed: Notify::new(),
            dir: Mutex::new((0, Value::Null, vec![])),
            pending_probes: Mutex::default(),
            pushed: AtomicU64::new(0),
            keys_seq: AtomicU64::new(now_ms()),
            wg_tap: Mutex::new(None),
            wg_relayed: AtomicU64::new(0),
            wg_dropped: AtomicU64::new(0),
        })
    }

    pub fn registry(&self) -> &Arc<dyn Registry> {
        &self.reg
    }

    pub fn trunk_key_b64u(&self) -> String {
        self.key.public_b64u()
    }

    pub fn online(&self, id: &str) -> bool {
        self.links.lock().unwrap().contains_key(id)
    }

    /// (linked since, from where) of a root's live link.
    pub fn link_info(&self, id: &str) -> Option<(u64, SocketAddr)> {
        self.links.lock().unwrap().get(id).map(|l| (l.since, l.peer))
    }

    pub fn online_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.links.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

    /// Where a device's requests go: its chosen door when that root is online and runs the app,
    /// else the first online root (enrollment order) that runs the app; None = `/offline`.
    pub fn door_for(&self, preferred: Option<&str>) -> Option<String> {
        let roots = self.reg.roots();
        let online = |r: &RootRec| r.has_app && self.online(&r.id);
        if let Some(p) = preferred {
            if roots.iter().any(|r| r.id == p && online(r)) {
                return Some(p.to_string());
            }
        }
        roots.iter().find(|r| online(r)).map(|r| r.id.clone())
    }

    /* ---------------------------------------------------------------- signed pushes */

    fn send_all(&self, frame: &[u8]) {
        for l in self.links.lock().unwrap().values() {
            let _ = l.out.send((OP_BIN, frame.to_vec()));
        }
    }

    fn directory_content(&self) -> Vec<DirRoot> {
        self.reg
            .roots()
            .into_iter()
            .map(|r| DirRoot {
                online: self.online(&r.id),
                id: r.id,
                name: r.name,
                wg_pub: r.wg_pub,
                wg_addr: r.wg_addr,
                dtls_fp: r.dtls_fp,
                has_app: r.has_app,
                has_voice: r.has_voice,
                peer_token_sha256: r.peer_token_sha256,
            })
            .collect()
    }

    /// The current signed directory (re-signed when its content changed).
    pub fn directory(&self) -> Value {
        let content = self.directory_content();
        let mut d = self.dir.lock().unwrap();
        if d.1.is_null() || d.2 != content {
            d.0 = (d.0 + 1).max(now_ms());
            d.1 = proto::sign_directory(&self.key, d.0, now_ms(), &content);
            d.2 = content;
        }
        d.1.clone()
    }

    /// Push the directory to every root when it changed since the last push.
    pub fn push_directory(&self) {
        let dir = self.directory();
        let seq = dir["seq"].as_u64().unwrap_or(0);
        if self.pushed.swap(seq, Ordering::SeqCst) != seq {
            let msg = proto::sign_json(&self.key, json!({ "t": "directory", "directory": dir }));
            self.send_all(&proto::ctrl(&msg));
        }
    }

    fn keys_msg(&self) -> Value {
        proto::sign_json(&self.key, json!({ "t": "keys", "seq": self.keys_seq.load(Ordering::Relaxed), "keys": self.auth.token_keys() }))
    }

    /// The token keys changed (a rotation, a retirement): every root hears it.
    pub fn push_keys(&self) {
        self.keys_seq.fetch_max(now_ms(), Ordering::Relaxed);
        self.keys_seq.fetch_add(1, Ordering::Relaxed);
        self.send_all(&proto::ctrl(&self.keys_msg()));
    }

    /// A device was revoked (spec §5.4): every root denies `did` until its last token expires.
    pub fn push_revoke(&self, did: &str, until: u64) {
        let msg = proto::sign_json(&self.key, json!({ "t": "revoke", "did": did, "until": until }));
        self.send_all(&proto::ctrl(&msg));
    }

    /// The kill switch moved the epoch (and maybe lockdown).
    pub fn push_kill(&self, epoch: u64, lockdown: bool) {
        let msg = proto::sign_json(&self.key, json!({ "t": "kill", "epoch": epoch, "lockdown": lockdown }));
        self.send_all(&proto::ctrl(&msg));
    }

    /// The registry marked `id` revoked: tell it, cut its link, drop its ICE routes, and push the
    /// directory without it (the other roots' wg nodes drop its peer at once).
    pub fn root_revoked(&self, id: &str) {
        let link = self.links.lock().unwrap().remove(id);
        if let Some(l) = link {
            let msg = proto::sign_json(&self.key, json!({ "t": "root.revoked", "root_id": id }));
            let _ = l.out.send((OP_BIN, proto::ctrl(&msg)));
            let _ = l.out.send((OP_CLOSE, vec![]));
            l.streams.lock().unwrap().clear();
        }
        self.ice.lock().unwrap().retain(|_, (r, _)| r != id);
        println!("  trunk: root {id} REVOKED — link cut, key refused, directory pushed");
        meter::event("root.revoked", json!({ "root": id }));
        self.push_directory();
    }

    /* ---------------------------------------------------------------- ICE routes */

    fn ice_register(&self, root: &str, ufrags: &[String], ttl_s: u64) -> Vec<String> {
        let ttl = Duration::from_secs(ttl_s.clamp(1, ICE_TTL_MAX));
        let mut ok = vec![];
        {
            let mut m = self.ice.lock().unwrap();
            for u in ufrags.iter().filter(|u| valid_ufrag(u)).take(64) {
                if let Some((other, _)) = m.get(u).filter(|(r, _)| r != root) {
                    // the newest registration wins; both are logged
                    eprintln!("  trunk: ufrag {u} registered by {root}, was {other} — the newest wins");
                    count("ice.takeover");
                }
                m.insert(u.clone(), (root.to_string(), Instant::now() + ttl));
                ok.push(u.clone());
            }
        }
        self.ice_changed.notify_waiters();
        ok
    }

    fn ice_release(&self, root: &str, ufrags: &[String]) {
        let mut m = self.ice.lock().unwrap();
        for u in ufrags {
            if m.get(u).is_some_and(|(r, _)| r == root) {
                m.remove(u);
            }
        }
    }

    /// The root that registered `ufrag` (an expired route is gone).
    pub fn ice_owner_now(&self, ufrag: &str) -> Option<String> {
        let mut m = self.ice.lock().unwrap();
        match m.get(ufrag) {
            Some((r, exp)) if *exp > Instant::now() && self.links.lock().unwrap().contains_key(r) => Some(r.clone()),
            Some(_) => {
                m.remove(ufrag);
                None
            }
            None => None,
        }
    }

    /// The owner, waiting up to `hold` for a late registration.
    pub async fn ice_owner(&self, ufrag: &str, hold: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + hold;
        loop {
            let notified = self.ice_changed.notified();
            if let Some(r) = self.ice_owner_now(ufrag) {
                return Some(r);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.ice_owner_now(ufrag);
            }
        }
    }

    /// An ICE-TCP connection (RFC 4571 framed STUN, the trunk's `listen_ice` or the shared :443):
    /// to the root that registered the first binding request's receiver ufrag, as the raw stream
    /// `livekit-ice` (the root splits its own peers from LiveKit, ap.rs `serve_raw`).
    pub async fn serve_ice(self: &Arc<Self>, tcp: tokio::net::TcpStream, peer: SocketAddr) {
        let _ = tcp.set_nodelay(true);
        let mut first = vec![0u8; 2 + 1500];
        let t0 = Instant::now();
        let frame = loop {
            let n = match timeout(Duration::from_secs(5).saturating_sub(t0.elapsed()), tcp.peek(&mut first)).await {
                Ok(Ok(n)) if n > 0 => n,
                _ => return count("ice.bad"),
            };
            if n >= 2 {
                let len = u16::from_be_bytes([first[0], first[1]]) as usize;
                if len > 1500 || (n >= 10 && !is_framed_stun(&first[..10])) {
                    return count("ice.bad");
                }
                if n >= 2 + len {
                    break first[2..2 + len].to_vec();
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        let Some(ufrag) = stun_receiver_ufrag(&frame) else { return count("ice.bad") };
        let Some(root) = self.ice_owner(&ufrag, ICE_HOLD).await else {
            return count("ice.unknown");
        };
        count("ice.routed");
        let _ = self.relay_raw(&root, tcp, peer.ip(), "livekit-ice").await;
    }

    /* ---------------------------------------------------------------- streams */

    fn link_of(&self, root: &str) -> Option<RootLink> {
        self.links.lock().unwrap().get(root).cloned()
    }

    /// A raw stream to `root` (nothing parsed): ICE-TCP.
    pub async fn relay_raw<S: Io + 'static>(self: &Arc<Self>, root: &str, io: S, client: IpAddr, name: &str) -> io::Result<()> {
        let Some(link) = self.link_of(root) else { return Ok(count("relay.raw.nolink")) };
        let id = self.ids.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        link.streams.lock().unwrap().insert(id, tx);
        let _ = link.out.send((OP_BIN, proto::mux(proto::OPEN_RAW, id, format!("{}\n{name}", client.to_canonical()).as_bytes())));
        let (mut rd, mut wr) = tokio::io::split(io);
        let up = link.out.clone();
        let reader = tokio::spawn(async move {
            let mut buf = vec![0u8; 16384];
            while let Ok(n) = rd.read(&mut buf).await {
                if n == 0 || up.send((OP_BIN, proto::mux(proto::DATA, id, &buf[..n]))).is_err() {
                    break;
                }
            }
            let _ = up.send((OP_BIN, proto::mux(proto::CLOSE, id, &[])));
        });
        while let Some(Some(chunk)) = rx.recv().await {
            if wr.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
        reader.abort();
        link.streams.lock().unwrap().remove(&id);
        let _ = link.out.send((OP_BIN, proto::mux(proto::CLOSE, id, &[])));
        Ok(())
    }

    /// One HTTP request to `root` (its whole exchange, then the connection ends). `head` is the
    /// request head as the client sent it (the root rewrites it), `rest` the bytes read past it.
    /// `hsts`: stamped on the answer (a trunk serving TLS itself; behind Caddy, None).
    pub async fn relay_http<S: Io + 'static>(
        self: &Arc<Self>,
        root: &str,
        mut io: S,
        client: IpAddr,
        head: &[u8],
        rest: Vec<u8>,
        hsts: Option<&str>,
    ) -> io::Result<()> {
        // P12 at the trunk too: no chunked bodies, one Content-Length
        if let Ok(h) = wsio::parse_head(head) {
            if h.header("transfer-encoding").is_some() {
                io.write_all(&wsio::http_response(411, "Length Required", "text/plain", "chunked request bodies are not proxied\n")).await?;
                return io.shutdown().await;
            }
            let lens: Vec<&str> = h.headers_all("content-length").collect();
            if lens.len() > 1 && lens.iter().any(|l| *l != lens[0]) {
                io.write_all(&wsio::http_response(400, "Bad Request", "text/plain", "conflicting content-length\n")).await?;
                return io.shutdown().await;
            }
        }
        let Some(link) = self.link_of(root) else {
            count("relay.nolink");
            io.write_all(&wsio::http_response(503, "Service Unavailable", "text/plain", "bifrost: that root is offline\n")).await?;
            return io.shutdown().await;
        };
        count("relay.streams");
        let id = self.ids.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        link.streams.lock().unwrap().insert(id, tx);
        let mut open = format!("{}\n", client.to_canonical()).into_bytes();
        open.extend_from_slice(head);
        let _ = link.out.send((OP_BIN, proto::mux(proto::OPEN, id, &open)));
        if !rest.is_empty() {
            let _ = link.out.send((OP_BIN, proto::mux(proto::DATA, id, &rest)));
        }
        let (mut rd, mut wr) = tokio::io::split(io);
        let up = link.out.clone();
        let reader = tokio::spawn(async move {
            let mut buf = vec![0u8; 16384];
            loop {
                match rd.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if up.send((OP_BIN, proto::mux(proto::DATA, id, &buf[..n]))).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = up.send((OP_BIN, proto::mux(proto::CLOSE, id, &[])));
        });
        let mut pending: Option<Vec<u8>> = hsts.map(|_| vec![]);
        while let Some(Some(chunk)) = rx.recv().await {
            if let (Some(mut hb), Some(h)) = (pending.take(), hsts) {
                hb.extend_from_slice(&chunk);
                match stamp_hsts(&hb, h) {
                    Some(out) => wr.write_all(&out).await?,
                    None if hb.len() > wsio::MAX_HEAD => wr.write_all(&hb).await?,
                    None => pending = Some(hb),
                }
                continue;
            }
            if wr.write_all(&chunk).await.is_err() {
                break;
            }
        }
        if let Some(hb) = pending.filter(|b| !b.is_empty()) {
            let _ = wr.write_all(&hb).await;
        }
        let _ = wr.shutdown().await;
        reader.abort();
        link.streams.lock().unwrap().remove(&id);
        let _ = link.out.send((OP_BIN, proto::mux(proto::CLOSE, id, &[])));
        Ok(())
    }

    /* ---------------------------------------------------------------- WireGuard */

    /// A WG frame from `src`'s link: `[n][dest][dgram]` → dest's link as `[n][src][dgram]`.
    fn wg_from(&self, src: &str, payload: &[u8]) {
        let drop = |why: &str| {
            let n = self.wg_dropped.fetch_add(1, Ordering::Relaxed);
            if n < 20 || n % 1000 == 0 {
                eprintln!("  trunk: dropped a WireGuard frame from {src}: {why}");
            }
        };
        let Some((to, dgram)) = crate::wg::unframe(payload) else { return drop("not a relay frame") };
        if crate::wg::wg_kind(dgram).is_none() {
            return drop("not a WireGuard message");
        }
        if to == src {
            return drop("addressed to itself");
        }
        let Some(link) = self.link_of(to) else { return drop("destination offline") };
        let out = crate::wg::frame(src, dgram);
        if let Some(t) = self.wg_tap.lock().unwrap().as_mut() {
            t.push(out.clone());
        }
        if link.out.send((OP_BIN, proto::mux(proto::WG, 0, &out))).is_ok() {
            self.wg_relayed.fetch_add(1, Ordering::Relaxed);
        }
    }

    /* ---------------------------------------------------------------- the trunk's probes (A13) */

    /// One channel probe to a root: a CTRL `probe` it must echo; the round trip over the whole
    /// link (this is the v1 `own_probe` — the round trip includes the trunk's websocket writer).
    pub async fn probe_root(&self, id: &str) -> Option<Duration> {
        let link = self.link_of(id)?;
        let pid = self.ids.fetch_add(1, Ordering::Relaxed) as u64 + 1;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_probes.lock().unwrap().insert(pid, tx);
        let t0 = Instant::now();
        if link.out.send((OP_BIN, proto::ctrl(&json!({ "t": "probe", "id": pid })))).is_err() {
            self.pending_probes.lock().unwrap().remove(&pid);
            return None;
        }
        let ok = tokio::time::timeout(Duration::from_secs(2), rx).await.is_ok_and(|r| r.is_ok());
        self.pending_probes.lock().unwrap().remove(&pid);
        ok.then(|| t0.elapsed())
    }

    /// The root echoed a probe: wake its waiter.
    fn probe_answered(&self, id: u64) {
        if let Some(tx) = self.pending_probes.lock().unwrap().remove(&id) {
            let _ = tx.send(());
        }
    }

    /// The trunk's minute lines, to the obs sink root (the first online root with the app) as a
    /// `stats` CTRL (the root's bridge ingests them into its own obs folder — the v0.9 STATS home).
    pub fn push_stats_line(&self, line: &Value) {
        let Some(root) = self.door_for(None) else { return };
        if let Some(l) = self.link_of(&root) {
            let _ = l.out.send((OP_BIN, proto::ctrl(&json!({ "t": "stats", "lines": [line] }))));
        }
    }

    /* ---------------------------------------------------------------- WS /t/root */

    /// `GET /t/root` after the server read its head: the upgrade, the proto-2 handshake, then the
    /// link until it ends. 426 for a v0.9 bridge or another proto.
    pub async fn serve_root<S: Io + 'static>(self: &Arc<Self>, mut io: S, peer: SocketAddr, head: &[u8], rest: Vec<u8>) -> io::Result<()> {
        let h = match wsio::parse_head(head) {
            Ok(h) => h,
            Err(e) => {
                io.write_all(&wsio::http_response(400, "Bad Request", "text/plain", &format!("{e}\n"))).await?;
                return io.shutdown().await;
            }
        };
        let proto_ok = h.header(proto::PROTO_HEADER).map(str::trim) == Some("2");
        if !proto_ok {
            count("root.refused.proto");
            let body = if h.header("authorization").is_some() {
                "update this computer: this is a v1 trunk (proto 2); a v0.9 bridge cannot link here\n"
            } else {
                "update this computer: this trunk speaks proto 2\n"
            };
            io.write_all(&wsio::http_response(426, "Upgrade Required", "text/plain", body)).await?;
            return io.shutdown().await;
        }
        let Some(answer) = wsio::upgrade_answer(&h) else {
            io.write_all(&wsio::http_response(400, "Bad Request", "text/plain", "websocket upgrade required\n")).await?;
            return io.shutdown().await;
        };
        if !rest.is_empty() {
            return io.shutdown().await;
        }
        io.write_all(answer.as_bytes()).await?;
        let (mut rd, mut wr) = tokio::io::split(io);
        // 1. hello
        let trunk_nonce = proto::nonce();
        let hello = proto::hello(&self.trunk_id, &self.key.public_b64u(), &trunk_nonce);
        wsio::ws_send(&mut wr, OP_BIN, &proto::ctrl(&hello), false).await?;
        // 2. auth
        let auth = match timeout(HANDSHAKE_WAIT, recv_ctrl(&mut rd)).await {
            Ok(Ok(v)) => v,
            _ => {
                count("root.refused.handshake");
                return Ok(());
            }
        };
        let reg = self.reg.clone();
        let checked = proto::check_auth(&auth, &self.trunk_id, &trunk_nonce, |id| match reg.root(id) {
            None => Err(proto::Refusal::UnknownRoot),
            Some(r) if r.revoked => Err(proto::Refusal::Revoked),
            Some(r) => Ok(r.root_pub),
        });
        let (root_id, root_nonce) = match checked {
            Ok(x) => x,
            Err(why) => {
                let word = match why {
                    proto::Refusal::Revoked => "revoked",
                    proto::Refusal::UnknownRoot => "unknown",
                    proto::Refusal::BadSig => "bad-signature",
                    _ => "protocol",
                };
                count(&format!("root.refused.{word}"));
                eprintln!("  trunk: root link from {peer} REFUSED ({why})");
                // signed, bound to the root's nonce: the root can trust a `revoked`
                let msg = proto::sign_json(
                    &self.key,
                    json!({ "t": "refused", "why": word, "root_id": auth["root_id"], "nonce": auth["nonce"] }),
                );
                let _ = wsio::ws_send(&mut wr, OP_BIN, &proto::ctrl(&msg), false).await;
                let _ = wsio::ws_send(&mut wr, OP_CLOSE, &[], false).await;
                return Ok(());
            }
        };
        let rec = self.reg.root(&root_id).expect("checked above");
        // 3. welcome — then the signed authority messages (the welcome's own copies only tighten)
        let (epoch_k, lockdown) = self.auth.kill();
        let deny = self.auth.deny();
        let (out, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
        let streams: Arc<Mutex<HashMap<u32, StreamTx>>> = Arc::default();
        let epoch = self.gens.fetch_add(1, Ordering::Relaxed) + 1;
        let old = self.links.lock().unwrap().insert(
            root_id.clone(),
            RootLink { epoch, out: out.clone(), streams: streams.clone(), since: now_ms(), peer },
        );
        if let Some(old) = old {
            old.streams.lock().unwrap().clear();
            let _ = old.out.send((OP_CLOSE, vec![]));
        }
        let welcome = json!({
            "t": "welcome",
            "sig": proto::welcome_sig(&self.key, &root_id, &root_nonce, &trunk_nonce),
            "root": { "id": rec.id, "name": rec.name, "wg_addr": rec.wg_addr, "has_app": rec.has_app, "has_voice": rec.has_voice },
            "directory": self.directory(),
            "keys": self.auth.token_keys(),
            "kill_epoch": epoch_k,
            "deny": deny,
        });
        let _ = out.send((OP_BIN, proto::ctrl(&welcome)));
        let _ = out.send((OP_BIN, proto::ctrl(&self.keys_msg())));
        let _ = out.send((OP_BIN, proto::ctrl(&proto::sign_json(&self.key, json!({ "t": "kill", "epoch": epoch_k, "lockdown": lockdown })))));
        for d in &deny {
            let _ = out.send((OP_BIN, proto::ctrl(&proto::sign_json(&self.key, json!({ "t": "revoke", "did": d.did, "until": d.until })))));
        }
        let writer = tokio::spawn(async move {
            while let Some((op, p)) = out_rx.recv().await {
                if wsio::ws_send(&mut wr, op, &p, false).await.is_err() || op == OP_CLOSE {
                    break;
                }
            }
            let _ = wr.shutdown().await;
        });
        self.reg.seen(&root_id, now_ms());
        println!("  trunk: root {root_id} ({}) linked from {peer} (link #{epoch})", rec.name);
        count("root.link.up");
        self.push_directory();
        let why = loop {
            let (op, p) = match timeout(SILENT, wsio::ws_recv(&mut rd, Some(true))).await {
                Ok(Ok(x)) => x,
                Ok(Err(_)) => break "error",
                Err(_) => break "silent",
            };
            if self.links.lock().unwrap().get(&root_id).map(|l| l.epoch) != Some(epoch) {
                break "taken over";
            }
            match op {
                OP_BIN => {
                    let Some((kind, id, body)) = proto::unmux(&p) else { continue };
                    match kind {
                        proto::DATA => {
                            let tx = streams.lock().unwrap().get(&id).cloned();
                            if let Some(tx) = tx {
                                let _ = tx.send(Some(body.to_vec()));
                            }
                        }
                        proto::CLOSE => {
                            if let Some(tx) = streams.lock().unwrap().remove(&id) {
                                let _ = tx.send(None);
                            }
                        }
                        proto::WG => self.wg_from(&root_id, body),
                        proto::CTRL => {
                            let Some(m) = proto::parse_ctrl(body) else { continue };
                            match m["t"].as_str().unwrap_or_default() {
                                "ice.register" => {
                                    let ufrags: Vec<String> = m["ufrags"].as_array().into_iter().flatten().filter_map(|u| u.as_str().map(str::to_string)).collect();
                                    let ok = self.ice_register(&root_id, &ufrags, m["ttl_s"].as_u64().unwrap_or(proto::ICE_TTL_S));
                                    let _ = out.send((OP_BIN, proto::ctrl(&json!({ "t": "ice.ack", "ufrags": ok }))));
                                }
                                "ice.release" => {
                                    let ufrags: Vec<String> = m["ufrags"].as_array().into_iter().flatten().filter_map(|u| u.as_str().map(str::to_string)).collect();
                                    self.ice_release(&root_id, &ufrags);
                                }
                                "probe" => {
                                    // the trunk's channel probe, echoed by the root (link.rs)
                                    if let Some(pid) = m["id"].as_u64() {
                                        self.probe_answered(pid);
                                    }
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                OP_PING => {
                    let _ = out.send((OP_PONG, p));
                    self.reg.seen(&root_id, now_ms());
                }
                OP_CLOSE => break "closed",
                _ => {}
            }
        };
        let mine = {
            let mut l = self.links.lock().unwrap();
            if l.get(&root_id).map(|x| x.epoch) == Some(epoch) {
                l.remove(&root_id);
                true
            } else {
                false
            }
        };
        streams.lock().unwrap().clear();
        let _ = out.send((OP_CLOSE, vec![]));
        let _ = timeout(Duration::from_secs(2), writer).await;
        if mine {
            self.ice.lock().unwrap().retain(|_, (r, _)| *r != root_id);
            println!("  trunk: root {root_id} link #{epoch} down ({why})");
            self.push_directory();
        }
        Ok(())
    }
}

async fn recv_ctrl<R: tokio::io::AsyncRead + Unpin>(rd: &mut R) -> io::Result<Value> {
    loop {
        let (op, p) = wsio::ws_recv(rd, Some(true)).await?;
        match op {
            OP_BIN => {
                let bad = || io::Error::new(io::ErrorKind::InvalidData, "not a CTRL message");
                let (kind, _, body) = proto::unmux(&p).ok_or_else(bad)?;
                if kind != proto::CTRL {
                    return Err(bad());
                }
                return proto::parse_ctrl(body).ok_or_else(bad);
            }
            OP_PING | OP_PONG => continue,
            _ => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "closed in the handshake")),
        }
    }
}

/// An ICE ufrag as RFC 8445 allows (ice-char: ALPHA / DIGIT / "+" / "/"), 4–256 chars.
fn valid_ufrag(u: &str) -> bool {
    (4..=256).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// RFC 6544 framed STUN (the same rule as ap.rs / sni-443.py).
pub fn is_framed_stun(b: &[u8]) -> bool {
    if b.len() < 10 || b[2] & 0xC0 != 0 || b[6..10] != [0x21, 0x12, 0xA4, 0x42] {
        return false;
    }
    let frame = u16::from_be_bytes([b[0], b[1]]) as usize;
    let size = u16::from_be_bytes([b[4], b[5]]) as usize;
    frame == size + 20 && size % 4 == 0
}

/// The receiver's ufrag in a binding request: USERNAME = "<receiver>:<sender>" (ap.rs:168).
pub fn stun_receiver_ufrag(msg: &[u8]) -> Option<String> {
    if msg.len() < 20 || msg[4..8] != [0x21, 0x12, 0xA4, 0x42] {
        return None;
    }
    let end = (20 + u16::from_be_bytes([msg[2], msg[3]]) as usize).min(msg.len());
    let mut p = 20;
    while p + 4 <= end {
        let (t, l) = (u16::from_be_bytes([msg[p], msg[p + 1]]), u16::from_be_bytes([msg[p + 2], msg[p + 3]]) as usize);
        let v = msg.get(p + 4..p + 4 + l)?;
        if t == 0x0006 {
            let user = std::str::from_utf8(v).ok()?;
            return Some(user.split(':').next()?.to_string());
        }
        p += 4 + l.div_ceil(4) * 4;
    }
    None
}

/// Insert HSTS after the status line once the response head is complete.
fn stamp_hsts(head: &[u8], hsts: &str) -> Option<Vec<u8>> {
    let end = head.windows(4).position(|w| w == b"\r\n\r\n")?;
    let line = head.windows(2).position(|w| w == b"\r\n")?;
    let lower = String::from_utf8_lossy(&head[..end]).to_ascii_lowercase();
    if lower.contains("\r\nstrict-transport-security:") {
        return Some(head.to_vec());
    }
    let mut out = Vec::with_capacity(head.len() + 64);
    out.extend_from_slice(&head[..line + 2]);
    out.extend_from_slice(format!("Strict-Transport-Security: {hsts}\r\n").as_bytes());
    out.extend_from_slice(&head[line + 2..]);
    Some(out)
}

/// A registry kept in memory (tests, rigs).
#[derive(Default)]
pub struct MemRegistry {
    pub roots: Mutex<Vec<RootRec>>,
}

impl Registry for MemRegistry {
    fn root(&self, id: &str) -> Option<RootRec> {
        self.roots.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }
    fn roots(&self) -> Vec<RootRec> {
        self.roots.lock().unwrap().iter().filter(|r| !r.revoked).cloned().collect()
    }
}

/// An authority kept in memory (tests, rigs).
#[derive(Default)]
pub struct MemAuthority {
    pub keys: Mutex<Vec<Key>>,
    pub kill: Mutex<(u64, bool)>,
    pub deny: Mutex<Vec<DenyEntry>>,
}

impl Authority for MemAuthority {
    fn token_keys(&self) -> Vec<Key> {
        self.keys.lock().unwrap().clone()
    }
    fn kill(&self) -> (u64, bool) {
        *self.kill.lock().unwrap()
    }
    fn deny(&self) -> Vec<DenyEntry> {
        let now = now_ms();
        self.deny.lock().unwrap().iter().filter(|d| d.until > now).cloned().collect()
    }
}

