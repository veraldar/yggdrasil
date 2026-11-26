//! The root's side of `WS /t/root` (bridge.toml `[trunk]`, CONTRACTS.md C4/C5).
//!
//! The bridge dials OUT to its trunk (the box never accepts inbound internet), proves its root
//! key, checks the trunk's answer against the trunk key it was enrolled with (a TLS-terminating
//! front cannot impersonate the trunk), and then serves:
//!   * OPEN streams: a device's HTTP request relayed by the trunk — the same stream law as the v0.9
//!     edge (ap.rs `serve_stream`: the device gate, now PASETO offline; one request per connection;
//!     chunked → 411; conflicting Content-Length → 400; header hygiene; `X-Bifrost-Edge`);
//!   * OPEN_RAW streams: ICE-TCP (`livekit-ice`), split own-vs-LiveKit by ufrag as today;
//!   * WG frames: WireGuard datagrams between this root's `bifrost-net wg` node (a loopback UDP
//!     pair) and the other roots — ciphertext only, relayed by the trunk;
//!   * CTRL: the signed directory, keys, revocations, the kill switch, `root.revoked`, ICE acks.
//!
//! Every authority message must carry a good trunk signature; anything else is dropped and
//! counted (`ctrl.badsig`). The welcome's own fields can only make the root stricter (a higher
//! kill epoch, more denied devices): keys come only from a signed `keys` message, the directory
//! only with its own signature.
//!
//! `trunk-state.json` (state.rs) is rewritten on every change and at least every 10 s.

use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::proto::{self, SignKey};
use super::state::{now_ms, DenyEntry, Key, TrunkState};
use super::wsio::{self, Io, OP_BIN, OP_CLOSE, OP_PING, OP_PONG};
use crate::meter::{self, C as MC, L as ML};

const PING_EVERY: Duration = Duration::from_secs(15);
const SILENT: Duration = Duration::from_secs(45);
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// spec §5.7: the bridge waits this long for the trunk's ack before it answers with the SDP
pub const ICE_ACK_WAIT: Duration = Duration::from_millis(500);

pub type Frames = mpsc::UnboundedSender<(u8, Vec<u8>)>;

pub struct LinkConfig {
    /// the trunk's origin: `https://host[:port]` (TLS; `pin` or the web PKI) or `http://host:port`
    /// (plain: loopback rigs, a front on the same host)
    pub url: String,
    pub pin: Option<String>,
    /// the trunk key this root was enrolled with (b64url Ed25519 public)
    pub trunk_key: String,
    pub root_id: String,
    pub root_key: Arc<SignKey>,
    pub state: Arc<TrunkState>,
    /// the stream law and its targets (ap.rs): upstream app, LiveKit, raw forwards, ICE demux,
    /// and the device gate (`tokens` in trunk mode)
    pub dial: Arc<crate::ap::DialConfig>,
    /// (this bridge's loopback relay socket, the local wg node's udp) — None = no WireGuard
    pub wg: Option<(SocketAddr, SocketAddr)>,
    /// the bridge's own str0m ufrags (inserted at /offer, removed by the sweep)
    pub ufrags: Arc<Mutex<HashSet<String>>>,
}

pub struct Link {
    cfg: LinkConfig,
    trunk_pub: [u8; 32],
    out: Mutex<Option<Frames>>,
    /// ufrags the trunk acknowledged on the current link
    acked: Mutex<HashSet<String>>,
    acked_cv: Condvar,
    /// ufrags registered on the current link (renewed every ICE_RENEW_S, released when gone)
    held: Mutex<HashMap<String, Instant>>,
    keys_seq: Mutex<u64>,
    revoked: AtomicBool,
    wg_sock: Option<UdpSocket>,
    pub wg_relayed: std::sync::atomic::AtomicU64,
    pub wg_dropped: std::sync::atomic::AtomicU64,
}

fn badsig(what: &str) {
    meter::inc_named("ctrl.badsig");
    eprintln!("  trunk: dropped a '{what}' control message — not signed by this root's trunk");
}

impl Link {
    /// Start the link on its own runtime thread; reconnects with backoff, forever (until the trunk
    /// revokes this root).
    pub fn spawn(cfg: LinkConfig) -> Result<Arc<Link>, String> {
        let trunk_pub = proto::public_from_b64u(&cfg.trunk_key).ok_or("[trunk] trunk_key is not a b64url Ed25519 public key")?;
        let wg_sock = match cfg.wg {
            Some((bind, local)) => {
                if !bind.ip().is_loopback() || !local.ip().is_loopback() {
                    return Err("[trunk] wg_relay / wg_local are loopback only".into());
                }
                Some(UdpSocket::bind(bind).map_err(|e| format!("[trunk] wg_relay bind {bind}: {e}"))?)
            }
            None => None,
        };
        cfg.state.update(|s| {
            s.trunk.url = cfg.url.clone();
            s.trunk.trunk_key = cfg.trunk_key.clone();
            s.root.id = cfg.root_id.clone();
        });
        cfg.state.spawn_writer();
        let link = Arc::new(Link {
            cfg,
            trunk_pub,
            out: Mutex::new(None),
            acked: Mutex::default(),
            acked_cv: Condvar::new(),
            held: Mutex::default(),
            keys_seq: Mutex::new(0),
            revoked: AtomicBool::new(false),
            wg_sock,
            wg_relayed: Default::default(),
            wg_dropped: Default::default(),
        });
        if let Some(sock) = link.wg_sock.as_ref().and_then(|s| s.try_clone().ok()) {
            let l = Arc::downgrade(&link);
            std::thread::Builder::new()
                .name("trunk-wg".into())
                .spawn(move || {
                    let mut buf = vec![0u8; 65536];
                    loop {
                        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
                        let Some(l) = l.upgrade() else { return };
                        l.from_local_node(&buf[..n], from);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        let l = link.clone();
        std::thread::Builder::new()
            .name("trunk-link".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
                rt.spawn(l.clone().ice_sync());
                rt.block_on(l.dial_forever());
            })
            .map_err(|e| e.to_string())?;
        Ok(link)
    }

    pub fn state(&self) -> &Arc<TrunkState> {
        &self.cfg.state
    }

    pub fn dial(&self) -> Arc<crate::ap::DialConfig> {
        self.cfg.dial.clone()
    }

    pub fn is_up(&self) -> bool {
        self.out.lock().unwrap().is_some()
    }

    fn send(&self, frame: Vec<u8>) -> bool {
        match self.out.lock().unwrap().as_ref() {
            Some(o) => o.send((OP_BIN, frame)).is_ok(),
            None => false,
        }
    }

    fn send_ctrl(&self, msg: Value) -> bool {
        self.send(proto::ctrl(&msg))
    }

    /* ---------------------------------------------------------------- ICE ufrags (§5.7) */

    /// Register `ufrags` with the trunk and wait for its ack (≤ `wait`). False = no ack in time
    /// (the caller goes on: `ice.reg_timeout`), or no link.
    pub fn register_wait(&self, ufrags: &[String], wait: Duration) -> bool {
        if ufrags.is_empty() {
            return true;
        }
        {
            let mut h = self.held.lock().unwrap();
            for u in ufrags {
                h.insert(u.clone(), Instant::now());
            }
        }
        if !self.send_ctrl(json!({ "t": "ice.register", "ufrags": ufrags, "ttl_s": proto::ICE_TTL_S })) {
            meter::inc_named("ice.reg_timeout");
            return false;
        }
        let deadline = Instant::now() + wait;
        let mut a = self.acked.lock().unwrap();
        while !ufrags.iter().all(|u| a.contains(u)) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                meter::inc_named("ice.reg_timeout");
                return false;
            }
            a = self.acked_cv.wait_timeout(a, left).unwrap().0;
        }
        true
    }

    /// Keep the trunk's routes in line with the bridge's live ufrags: new ones registered, gone
    /// ones released, all renewed every ICE_RENEW_S.
    async fn ice_sync(self: Arc<Self>) {
        let mut last_renew = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !self.is_up() {
                continue;
            }
            let live: HashSet<String> = self.cfg.ufrags.lock().unwrap().clone();
            let (new, gone): (Vec<String>, Vec<String>) = {
                let mut h = self.held.lock().unwrap();
                let new: Vec<String> = live.iter().filter(|u| !h.contains_key(*u)).cloned().collect();
                let gone: Vec<String> = h.keys().filter(|u| !live.contains(*u)).cloned().collect();
                for u in &gone {
                    h.remove(u);
                }
                for u in &new {
                    h.insert(u.clone(), Instant::now());
                }
                (new, gone)
            };
            if !gone.is_empty() {
                self.acked.lock().unwrap().retain(|u| !gone.contains(u));
                self.send_ctrl(json!({ "t": "ice.release", "ufrags": gone }));
            }
            let renew = last_renew.elapsed() >= Duration::from_secs(proto::ICE_RENEW_S);
            let ask: Vec<String> = if renew { self.held.lock().unwrap().keys().cloned().collect() } else { new };
            if renew {
                last_renew = Instant::now();
            }
            if !ask.is_empty() {
                self.send_ctrl(json!({ "t": "ice.register", "ufrags": ask, "ttl_s": proto::ICE_TTL_S }));
            }
        }
    }

    /* ---------------------------------------------------------------- WireGuard */

    /// A relay frame from this root's own wg node (`[n][dest root][dgram]`): to the trunk.
    fn from_local_node(&self, buf: &[u8], from: SocketAddr) {
        if Some(from) != self.cfg.wg.map(|w| w.1) {
            self.wg_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let ok = crate::wg::unframe(buf).is_some_and(|(to, d)| to != self.cfg.root_id && crate::wg::wg_kind(d).is_some());
        if !ok || !self.send(proto::mux(proto::WG, 0, buf)) {
            self.wg_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.wg_relayed.fetch_add(1, Ordering::Relaxed);
    }

    /// A WG frame from the trunk (`[n][source root][dgram]`): to the local node.
    fn from_trunk_wg(&self, payload: &[u8]) {
        let (Some(sock), Some((_, local))) = (&self.wg_sock, self.cfg.wg) else { return };
        let ok = crate::wg::unframe(payload).is_some_and(|(src, d)| src != self.cfg.root_id && crate::wg::wg_kind(d).is_some());
        if !ok || sock.send_to(payload, local).is_err() {
            self.wg_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.wg_relayed.fetch_add(1, Ordering::Relaxed);
    }

    /* ---------------------------------------------------------------- control messages */

    fn apply_directory(&self, dir: &Value) -> bool {
        let Some((seq, roots)) = proto::verify_directory(&self.trunk_pub, dir) else {
            badsig("directory");
            return false;
        };
        let held = self.cfg.state.with(|s| s.directory["seq"].as_u64());
        if held.is_some_and(|h| seq < h) {
            return false; // an older copy (a replay or a reorder): keep the newer one
        }
        let me = roots.iter().find(|r| r.id == self.cfg.root_id).map(|r| r.name.clone());
        self.cfg.state.update(|s| {
            s.directory = dir.clone();
            if let Some(n) = me {
                s.root.name = n;
            }
        });
        true
    }

    fn apply_keys(&self, msg: &Value) {
        let seq = msg["seq"].as_u64().unwrap_or(0);
        {
            let mut held = self.keys_seq.lock().unwrap();
            if seq < *held {
                return;
            }
            *held = seq;
        }
        let keys: Vec<Key> = match serde_json::from_value(msg["keys"].clone()) {
            Ok(k) => k,
            Err(_) => return,
        };
        let issuers: Vec<String> = msg["issuers"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        self.cfg.state.update(|s| {
            s.keys = keys;
            if !issuers.is_empty() {
                s.trunk.issuers = issuers;
            }
        });
    }

    fn apply_revoke(&self, did: &str, until: u64) {
        if did.is_empty() {
            return;
        }
        let now = now_ms();
        self.cfg.state.revoked_at.lock().unwrap().entry(did.to_string()).or_insert(now);
        self.cfg.state.update(|s| match s.deny.iter_mut().find(|d| d.did == did) {
            Some(d) => d.until = d.until.max(until),
            None => s.deny.push(DenyEntry { did: did.to_string(), until }),
        });
    }

    fn apply_kill(&self, epoch: u64, lockdown: bool) {
        let moved = self.cfg.state.with(|s| epoch > s.kill_epoch);
        if moved {
            *self.cfg.state.killed_at.lock().unwrap() = Some(now_ms());
        }
        self.cfg.state.update(|s| {
            if epoch >= s.kill_epoch {
                s.kill_epoch = epoch;
                s.lockdown = lockdown;
            }
        });
    }

    fn revoked_by_trunk(&self) {
        if !self.revoked.swap(true, Ordering::SeqCst) {
            println!("  trunk: this root was REVOKED by trunk {} — the link stays down (re-enroll to come back)", self.cfg.url);
            meter::event("link.revoked", json!({}));
        }
        self.cfg.state.set_link("revoked");
        let _ = self.cfg.state.write_now();
    }

    /// One CTRL message from the trunk; returns an answer to send, if any.
    fn on_ctrl(&self, m: &Value) -> Option<Value> {
        let t = m["t"].as_str().unwrap_or_default();
        let signed = || proto::verify_json(&self.trunk_pub, m);
        match t {
            "directory" => {
                if !signed() {
                    badsig(t);
                } else {
                    self.apply_directory(&m["directory"]);
                }
            }
            "keys" => {
                if signed() {
                    self.apply_keys(m);
                } else {
                    badsig(t);
                }
            }
            "revoke" => {
                if signed() {
                    self.apply_revoke(m["did"].as_str().unwrap_or_default(), m["until"].as_u64().unwrap_or(0));
                } else {
                    badsig(t);
                }
            }
            "kill" => {
                if signed() {
                    self.apply_kill(m["epoch"].as_u64().unwrap_or(0), m["lockdown"].as_bool().unwrap_or(false));
                } else {
                    badsig(t);
                }
            }
            "root.revoked" => {
                if signed() && m["root_id"] == self.cfg.root_id.as_str() {
                    self.revoked_by_trunk();
                } else {
                    badsig(t);
                }
            }
            "ice.ack" => {
                let mut a = self.acked.lock().unwrap();
                for u in m["ufrags"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    a.insert(u.to_string());
                }
                self.acked_cv.notify_all();
            }
            "probe" => {
                meter::inc(&MC.probe_answered);
                return Some(json!({ "t": "probe", "id": m["id"] }));
            }
            "stats" => {
                // the trunk's minute lines (untrusted: size-capped by parse_ctrl, strictly parsed)
                for line in m["lines"].as_array().into_iter().flatten().take(meter::RING) {
                    if meter::ingest("ap", line.clone()) {
                        meter::inc(&MC.link_stats_in);
                    }
                }
            }
            _ => {}
        }
        None
    }

    /* ---------------------------------------------------------------- the link */

    async fn dial_forever(self: Arc<Self>) {
        let mut backoff = 1u64;
        loop {
            if self.revoked.load(Ordering::SeqCst) {
                return;
            }
            let t0 = Instant::now();
            self.cfg.state.set_link("connecting");
            let r = self.dial_once().await;
            *self.out.lock().unwrap() = None;
            self.held.lock().unwrap().clear();
            self.acked.lock().unwrap().clear();
            let up = meter::L.link.swap(0, Ordering::Relaxed) == 1;
            if self.revoked.load(Ordering::SeqCst) {
                return;
            }
            self.cfg.state.set_link("down");
            meter::event(if up { "link.down" } else { "link.fail" }, json!({ "up_s": if up { t0.elapsed().as_secs() } else { 0 } }));
            match r {
                Ok(()) => eprintln!("  trunk: link closed by the trunk"),
                Err(e) => eprintln!("  trunk: {e}"),
            }
            if t0.elapsed() > Duration::from_secs(30) {
                backoff = 1;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    }

    async fn connect(&self) -> Result<(Box<dyn Io>, String), String> {
        let (tls, host, port) = parse_origin(&self.cfg.url)?;
        let tcp = timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
            .await
            .map_err(|_| format!("connect {host}:{port}: timeout"))?
            .map_err(|e| format!("connect {host}:{port}: {e}"))?;
        let _ = tcp.set_nodelay(true);
        let hostport = if (tls && port == 443) || (!tls && port == 80) { host.clone() } else { format!("{host}:{port}") };
        if !tls {
            return Ok((Box::new(tcp), hostport));
        }
        let connector = match &self.cfg.pin {
            Some(pin) => crate::ap::pinned_client(pin)?,
            None => webpki_client(),
        };
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| format!("trunk host {host}: {e}"))?;
        let s = timeout(Duration::from_secs(10), connector.connect(name, tcp))
            .await
            .map_err(|_| "tls: timeout".to_string())?
            .map_err(|e| format!("tls: {e}"))?;
        Ok((Box::new(s), hostport))
    }

    async fn dial_once(self: &Arc<Self>) -> Result<(), String> {
        let t_dial = Instant::now();
        let (mut io, hostport) = self.connect().await?;
        let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, proto::random_bytes::<16>());
        let req = format!(
            "GET /t/root HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nX-Ygg-Proto: {}\r\n\r\n",
            proto::PROTO
        );
        io.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let (head, rest) = timeout(HANDSHAKE_WAIT, wsio::read_head(&mut io))
            .await
            .map_err(|_| "upgrade: timeout".to_string())?
            .map_err(|e| e.to_string())?
            .ok_or("the trunk closed during the upgrade")?;
        let text = String::from_utf8_lossy(&head).to_string();
        if !text.starts_with("HTTP/1.1 101") {
            let line = text.lines().next().unwrap_or("").to_string();
            if line.contains(" 426") {
                return Err(format!("the trunk refuses this bridge's protocol ({line}): {}", String::from_utf8_lossy(&rest).trim()));
            }
            return Err(format!("not a v1 trunk (proto {}): {line}", proto::PROTO));
        }
        if !text.contains(&wsio::ws_accept(&key)) {
            return Err("trunk upgrade answer has the wrong Sec-WebSocket-Accept".into());
        }
        // the hello may ride in the same read as the 101
        let (mut rd, mut wr) = tokio::io::split(wsio::Prefixed::new(rest, io));
        // 1. hello
        let hello = recv_ctrl(&mut rd).await?;
        let (trunk_id, trunk_nonce) = proto::check_hello(&hello, &self.cfg.trunk_key).map_err(|e| format!("handshake: {e}"))?;
        // 2. auth
        let root_nonce = proto::nonce();
        let auth = proto::auth(&self.cfg.root_key, &self.cfg.root_id, &trunk_id, &trunk_nonce, &root_nonce);
        wsio::ws_send(&mut wr, OP_BIN, &proto::ctrl(&auth), true).await.map_err(|e| e.to_string())?;
        // 3. welcome (or a signed refusal)
        let welcome = recv_ctrl(&mut rd).await?;
        if welcome["t"] == "refused" {
            let genuine = proto::verify_json(&self.trunk_pub, &welcome) && welcome["root_id"] == self.cfg.root_id.as_str() && welcome["nonce"] == root_nonce.as_str();
            if genuine && welcome["why"] == "revoked" {
                self.revoked_by_trunk();
                return Err("revoked by trunk".into());
            }
            return Err(format!("the trunk refused this root: {}{}", welcome["why"], if genuine { "" } else { " (unsigned)" }));
        }
        proto::check_welcome(&welcome, &self.trunk_pub, &self.cfg.root_id, &root_nonce, &trunk_nonce).map_err(|e| format!("handshake: {e}"))?;
        self.on_welcome(&welcome, &trunk_id);
        println!("  trunk: link up — {} as {} (trunk {trunk_id})", self.cfg.url, self.cfg.root_id);
        meter::inc(&MC.link_up);
        meter::set(&ML.link, 1);
        meter::event("link.up", json!({ "connect_ms": t_dial.elapsed().as_millis() as u64 }));

        let (out, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
        let writer = tokio::spawn(async move {
            while let Some((op, p)) = out_rx.recv().await {
                if wsio::ws_send(&mut wr, op, &p, true).await.is_err() || op == OP_CLOSE {
                    break;
                }
            }
            let _ = wr.shutdown().await;
        });
        *self.out.lock().unwrap() = Some(out.clone());
        self.cfg.state.set_link("up");
        // the routes of every live pinned peer (a reconnect: the trunk kept none)
        let live: Vec<String> = self.cfg.ufrags.lock().unwrap().iter().cloned().collect();
        if !live.is_empty() {
            let me = self.clone();
            tokio::task::spawn_blocking(move || me.register_wait(&live, ICE_ACK_WAIT));
        }
        let ping = {
            let out = out.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(PING_EVERY).await;
                    if out.send((OP_PING, now_ms().to_be_bytes().to_vec())).is_err() {
                        break;
                    }
                }
            })
        };
        let mut streams: HashMap<u32, mpsc::UnboundedSender<Option<Vec<u8>>>> = HashMap::new();
        let res = loop {
            let (op, p) = match timeout(SILENT, wsio::ws_recv(&mut rd, Some(false))).await {
                Ok(Ok(x)) => x,
                Ok(Err(e)) => break Err(format!("link: {e}")),
                Err(_) => break Err("link: trunk silent 45s".into()),
            };
            match op {
                OP_BIN => {
                    let Some((kind, id, body)) = proto::unmux(&p) else { continue };
                    match kind {
                        proto::OPEN => {
                            let (tx, rx) = mpsc::unbounded_channel();
                            streams.insert(id, tx);
                            tokio::spawn(crate::ap::serve_stream(self.cfg.dial.clone(), id, body.to_vec(), rx, out.clone()));
                        }
                        proto::OPEN_RAW => {
                            let (tx, rx) = mpsc::unbounded_channel();
                            streams.insert(id, tx);
                            tokio::spawn(crate::ap::serve_raw(self.cfg.dial.clone(), id, body.to_vec(), rx, out.clone()));
                        }
                        proto::DATA => {
                            if let Some(tx) = streams.get(&id) {
                                let _ = tx.send(Some(body.to_vec()));
                            }
                        }
                        proto::CLOSE => {
                            if let Some(tx) = streams.remove(&id) {
                                let _ = tx.send(None);
                            }
                        }
                        proto::WG => self.from_trunk_wg(body),
                        proto::CTRL => {
                            if let Some(m) = proto::parse_ctrl(body) {
                                if let Some(answer) = self.on_ctrl(&m) {
                                    let _ = out.send((OP_BIN, proto::ctrl(&answer)));
                                }
                                if self.revoked.load(Ordering::SeqCst) {
                                    break Ok(());
                                }
                            }
                        }
                        _ => {}
                    }
                    streams.retain(|_, tx| !tx.is_closed());
                }
                OP_PING => {
                    let _ = out.send((OP_PONG, p));
                }
                OP_PONG => {}
                OP_CLOSE => break Ok(()),
                _ => {}
            }
        };
        ping.abort();
        let _ = out.send((OP_CLOSE, vec![]));
        let _ = timeout(Duration::from_secs(2), writer).await;
        res
    }

    fn on_welcome(&self, w: &Value, trunk_id: &str) {
        // the directory stands on its own signature; kill epoch and deny-list may only tighten;
        // the keys come from the signed `keys` message that follows
        if !w["directory"].is_null() {
            self.apply_directory(&w["directory"]);
        }
        let epoch = w["kill_epoch"].as_u64().unwrap_or(0);
        let deny: Vec<DenyEntry> = serde_json::from_value(w["deny"].clone()).unwrap_or_default();
        let name = w["root"]["name"].as_str().map(str::to_string);
        self.cfg.state.update(|s| {
            s.trunk.trunk_id = trunk_id.to_string();
            s.kill_epoch = s.kill_epoch.max(epoch);
            for d in deny {
                match s.deny.iter_mut().find(|x| x.did == d.did) {
                    Some(x) => x.until = x.until.max(d.until),
                    None => s.deny.push(d),
                }
            }
            if let Some(n) = name.filter(|_| s.root.name.is_empty()) {
                s.root.name = n;
            }
        });
    }
}

async fn recv_ctrl<R: tokio::io::AsyncRead + Unpin>(rd: &mut R) -> Result<Value, String> {
    loop {
        let (op, p) = timeout(HANDSHAKE_WAIT, wsio::ws_recv(rd, Some(false)))
            .await
            .map_err(|_| "handshake: timeout".to_string())?
            .map_err(|e| format!("handshake: {e}"))?;
        match op {
            OP_BIN => {
                let (kind, _, body) = proto::unmux(&p).ok_or("handshake: bad frame")?;
                if kind != proto::CTRL {
                    return Err("handshake: mux traffic before the handshake".into());
                }
                return proto::parse_ctrl(body).ok_or_else(|| "handshake: not a JSON object".to_string());
            }
            OP_PING | OP_PONG => continue,
            OP_CLOSE => return Err("handshake: the trunk closed the link".into()),
            _ => return Err("handshake: unexpected frame".into()),
        }
    }
}

/// `https://host[:port][/…]` or `http://host:port` → (tls, host, port).
pub fn parse_origin(url: &str) -> Result<(bool, String, u16), String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(format!("[trunk] url {url:?}: want https://host[:port] (or http:// for a local rig)"));
    };
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, p.parse().map_err(|_| "[trunk] url: bad port")?),
        _ => (hostport, if tls { 443 } else { 80 }),
    };
    let host = host.trim_matches(|c| c == '[' || c == ']').to_string();
    if host.is_empty() {
        return Err("[trunk] url: no host".into());
    }
    Ok((tls, host, port))
}

fn webpki_client() -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .expect("tls versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offline_link(trunk: &SignKey) -> Arc<Link> {
        let state = TrunkState::open(None, "http://127.0.0.1:9", &trunk.public_b64u(), "rt_me");
        let tokens = Arc::new(crate::tokens::TokenStore::open_trunk(state.clone()));
        let dial = Arc::new(crate::ap::DialConfig {
            url: "http://127.0.0.1:9".into(),
            pin: String::new(),
            token: String::new(),
            upstream: "127.0.0.1:9".into(),
            livekit: None,
            tcp: Default::default(),
            rootlink: None,
            branch: None,
            tokens,
            ice_demux: None,
        });
        Link::spawn(LinkConfig {
            url: "http://127.0.0.1:9".into(),
            pin: None,
            trunk_key: trunk.public_b64u(),
            root_id: "rt_me".into(),
            root_key: Arc::new(SignKey::generate()),
            state,
            dial,
            wg: None,
            ufrags: Arc::default(),
        })
        .unwrap()
    }

    /// C4: authority only from the trunk's signature; replays of older state are not taken.
    #[test]
    fn unsigned_forged_or_older_authority_is_dropped() {
        let trunk = SignKey::generate();
        let evil = SignKey::generate();
        let l = offline_link(&trunk);
        let st = || l.state().snapshot();
        let key = json!([{ "kid": "k_x", "alg": "ed25519", "public": "AAAA", "retired_at": null }]);
        // unsigned / signed by another key: nothing changes
        for m in [
            json!({ "t": "keys", "seq": 1, "keys": key }),
            proto::sign_json(&evil, json!({ "t": "keys", "seq": 1, "keys": key })),
            json!({ "t": "kill", "epoch": 5, "lockdown": true }),
            proto::sign_json(&evil, json!({ "t": "revoke", "did": "dev_x", "until": now_ms() + 60_000 })),
            proto::sign_json(&evil, json!({ "t": "root.revoked", "root_id": "rt_me" })),
            json!({ "t": "directory", "directory": proto::sign_directory(&evil, 9, 1, &[]) }),
        ] {
            l.on_ctrl(&m);
        }
        let s = st();
        assert!(s.keys.is_empty() && s.kill_epoch == 0 && s.deny.is_empty() && s.directory.is_null() && s.link.state != "revoked", "{s:?}");
        // genuine: taken
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "keys", "seq": 5, "keys": key })));
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "kill", "epoch": 2, "lockdown": true })));
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "revoke", "did": "dev_x", "until": now_ms() + 60_000 })));
        let d7 = proto::sign_directory(&trunk, 7, 1, &[]);
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "directory", "directory": d7 })));
        let s = st();
        assert_eq!((s.keys.len(), s.kill_epoch, s.lockdown, s.deny.len(), s.directory["seq"].as_u64()), (1, 2, true, 1, Some(7)));
        // an inner directory forged under a genuine outer signature: refused
        let forged = proto::sign_json(&trunk, json!({ "t": "directory", "directory": proto::sign_directory(&evil, 8, 1, &[]) }));
        l.on_ctrl(&forged);
        assert_eq!(st().directory["seq"].as_u64(), Some(7));
        // replays of older state: an older directory, older keys, a lower kill epoch
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "directory", "directory": proto::sign_directory(&trunk, 6, 1, &[]) })));
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "keys", "seq": 4, "keys": [] })));
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "kill", "epoch": 1, "lockdown": false })));
        let s = st();
        assert_eq!((s.directory["seq"].as_u64(), s.keys.len(), s.kill_epoch, s.lockdown), (Some(7), 1, 2, true));
        // a root.revoked for another root is not ours; ours is
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "root.revoked", "root_id": "rt_other" })));
        assert_ne!(st().link.state, "revoked");
        l.on_ctrl(&proto::sign_json(&trunk, json!({ "t": "root.revoked", "root_id": "rt_me" })));
        assert_eq!(st().link.state, "revoked");
        // the welcome's own copies may only tighten
        l.on_welcome(&json!({ "kill_epoch": 1, "deny": [{ "did": "dev_y", "until": now_ms() + 1000 }], "keys": [{ "kid": "k_evil" }] }), "trk_1");
        let s = st();
        assert_eq!((s.kill_epoch, s.deny.len(), s.keys.len(), s.trunk.trunk_id.as_str()), (2, 2, 1, "trk_1"));
    }

    #[test]
    fn origins() {
        assert_eq!(parse_origin("https://ljoolq.veraldar.org"), Ok((true, "ljoolq.veraldar.org".into(), 443)));
        assert_eq!(parse_origin("https://t.example:4443/x"), Ok((true, "t.example".into(), 4443)));
        assert_eq!(parse_origin("http://127.0.0.1:18901"), Ok((false, "127.0.0.1".into(), 18901)));
        assert!(parse_origin("wss://x/ap").is_err());
        assert!(parse_origin("https://").is_err());
    }
}
