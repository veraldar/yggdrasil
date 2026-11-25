//! Loopback integration: one v1 trunk (this relay + a minimal server), two roots (each: the
//! bridge's `[trunk]` link, a `bifrost-net wg` node on the signed directory, a fake app, a fake
//! brain). Proves: a device token relayed to its door root (and re-checked offline there), a
//! root ↔ root call over WireGuard with only ciphertext on the trunk, the directory pushed and
//! read by the wg nodes, the brain's per-root token hashes on `/_wg/_roots`, ICE-TCP by registered
//! ufrag, the handshake refusals, and a revoked root cut within P13's 1.5 s.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream as StdTcp, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::hub::*;
use crate::v1::proto;
use crate::v1::state::now_ms;
use crate::v1::link::{Link, LinkConfig};
use crate::v1::proto::{kid_of, paseto_v4_sign, rfc3339, SignKey};
use crate::v1::state::{Key, StateFile, TrunkState};
use crate::v1::wsio;

const MARKER: &str = "PLAINTEXT-MARKER-7f3a9c";

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("v1-relay-{tag}-{}-{}", std::process::id(), proto::b64u(&proto::random_bytes::<6>())));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn http_server(f: impl Fn(&tiny_http::Request, Vec<u8>) -> (u16, String) + Send + 'static) -> SocketAddr {
    let srv = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = srv.server_addr().to_ip().unwrap();
    std::thread::spawn(move || {
        for mut rq in srv.incoming_requests() {
            let mut body = vec![];
            let _ = rq.as_reader().read_to_end(&mut body);
            let (st, out) = f(&rq, body);
            let h = tiny_http::Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).unwrap();
            let _ = rq.respond(tiny_http::Response::from_string(out).with_status_code(st).with_header(h));
        }
    });
    addr
}

fn hdr(rq: &tiny_http::Request, name: &'static str) -> Option<String> {
    rq.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.to_string())
}

/// The app at a root: names itself and what the bridge told it.
fn fake_app(name: &'static str) -> SocketAddr {
    http_server(move |rq, _| {
        (200, json!({ "app": name, "path": rq.url(), "xff": hdr(rq, "x-forwarded-for"), "edge": hdr(rq, "x-bifrost-edge").is_some(),
                      "cookie": hdr(rq, "cookie").is_some() }).to_string())
    })
}

/// A brain behind a wg node's in-tunnel door: who called, through what — and a body the trunk must
/// never be able to read.
fn fake_brain(name: &'static str) -> String {
    let a = http_server(move |rq, _| {
        (200, json!({ "brain": name, "from": hdr(rq, "x-ygg-from"), "via": hdr(rq, "x-ygg-via"), "peer": hdr(rq, "x-ygg-peer"), "secret": MARKER }).to_string())
    });
    format!("http://{a}")
}

fn http(addr: SocketAddr, req: &str) -> (u16, String) {
    let mut s = StdTcp::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut out = vec![];
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).to_string();
    let st = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (st, body)
}

fn get(addr: SocketAddr, path: &str, extra: &str) -> (u16, String) {
    http(addr, &format!("GET {path} HTTP/1.1\r\nHost: t\r\n{extra}\r\n"))
}

fn wait_for(what: &str, limit: Duration, mut f: impl FnMut() -> bool) -> Duration {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < limit, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
    t0.elapsed()
}

struct Trunk {
    addr: SocketAddr,
    ice: SocketAddr,
    hub: Arc<Hub>,
    reg: Arc<MemRegistry>,
    tok: Arc<SignKey>,
    doors: Arc<Mutex<HashMap<String, String>>>,
}

/// The minimal v1 server around the relay: `/t/root` → the relay; `/t/ice/owner`; everything else
/// needs a valid access token (C3, checked here as the IDP will) and goes to the device's door.
fn mini_trunk() -> Trunk {
    let key = Arc::new(SignKey::generate());
    let tok = Arc::new(SignKey::generate());
    let reg = Arc::new(MemRegistry::default());
    let auth = Arc::new(MemAuthority::default());
    auth.keys.lock().unwrap().push(Key { kid: kid_of(&tok.public()), alg: "ed25519".into(), public: tok.public_b64u(), retired_at: None });
    let hub = Hub::new("trk_test", key, reg.clone(), auth.clone());
    let doors: Arc<Mutex<HashMap<String, String>>> = Arc::default();
    let (tx, rx) = std::sync::mpsc::channel();
    let (h2, d2, a2) = (hub.clone(), doors.clone(), auth.clone());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        rt.block_on(async move {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let ice = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send((l.local_addr().unwrap(), ice.local_addr().unwrap())).unwrap();
            let h3 = h2.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((tcp, peer)) = ice.accept().await else { continue };
                    let h = h3.clone();
                    tokio::spawn(async move { h.serve_ice(tcp, peer).await });
                }
            });
            loop {
                let Ok((mut tcp, peer)) = l.accept().await else { continue };
                let (hub, doors, auth) = (h2.clone(), d2.clone(), a2.clone());
                tokio::spawn(async move {
                    let Ok(Some((head, rest))) = wsio::read_head(&mut tcp).await else { return };
                    let Ok(h) = wsio::parse_head(&head) else { return };
                    let path = h.path.split('?').next().unwrap_or("").to_string();
                    if path == "/t/root" {
                        let _ = hub.serve_root(tcp, peer, &head, rest).await;
                        return;
                    }
                    let reply = |st: u16, body: Value| wsio::http_response(st, "X", "application/json", &body.to_string());
                    use tokio::io::AsyncWriteExt;
                    if path == "/t/ice/owner" {
                        let u = h.path.split_once("u=").map(|x| x.1).unwrap_or("");
                        let r = match hub.ice_owner_now(u) {
                            Some(root) => reply(200, json!({ "root": root })),
                            None => reply(404, json!({})),
                        };
                        let _ = tcp.write_all(&r).await;
                        return;
                    }
                    let mut st = StateFile::new("http://t", "", "");
                    st.keys = auth.token_keys();
                    let raw = h.cookie("bifrost_device").or_else(|| h.header("authorization").and_then(crate::tokens::bearer).map(str::to_string)).unwrap_or_default();
                    match crate::v1::state::check_token(&st, &raw, &crate::region::region_of(peer.ip()), now_ms()) {
                        Err(w) => {
                            let _ = tcp.write_all(&reply(401, json!({ "why": w.word(), "reauth": w.reauth() }))).await;
                        }
                        Ok(c) => {
                            let pref = doors.lock().unwrap().get(&c.did).cloned();
                            match hub.door_for(pref.as_deref()) {
                                Some(door) => {
                                    let _ = hub.relay_http(&door, tcp, peer.ip(), &head, rest, Some("max-age=31536000")).await;
                                }
                                None => {
                                    let _ = tcp.write_all(&reply(503, json!({ "offline": true }))).await;
                                }
                            }
                        }
                    }
                });
            }
        });
    });
    let (addr, ice) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    Trunk { addr, ice, hub, reg, tok, doors }
}

impl Trunk {
    fn token(&self, did: &str, rgn: &str, kep: u64, ttl_ms: u64) -> String {
        let footer = json!({ "kid": kid_of(&self.tok.public()) }).to_string();
        let now = now_ms();
        let claims = json!({ "iss": "http://t", "sub": "acc_1", "did": did, "role": "admin", "rgn": rgn, "kep": kep,
                             "iat": rfc3339(now), "exp": rfc3339(now + ttl_ms), "jti": proto::b64u(&proto::random_bytes::<16>()) });
        paseto_v4_sign(&self.tok, &claims, footer.as_bytes())
    }
}

struct Root {
    id: String,
    link: Arc<Link>,
    state_path: std::path::PathBuf,
    wg: crate::wg::NodeHandle,
    token: String,
    key: Arc<SignKey>,
}

fn free_udp_port() -> SocketAddr {
    UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap()
}

/// Enroll a root into the registry (what F3/F4 end in) and start its side.
fn root(t: &Trunk, dir: &std::path::Path, id: &str, name: &'static str, addr: &str, has_app: bool) -> Root {
    let d = dir.join(id);
    std::fs::create_dir_all(&d).unwrap();
    let key = Arc::new(SignKey::generate());
    let (_, wg_pub) = crate::wg::load_or_create_key(&d.join("wg.key").to_string_lossy()).unwrap();
    let token = format!("ygg-peer-{}", proto::b64u(&proto::random_bytes::<24>()));
    t.reg.roots.lock().unwrap().push(RootRec {
        id: id.into(),
        name: name.into(),
        root_pub: key.public(),
        wg_pub: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wg_pub.as_bytes()),
        wg_addr: addr.into(),
        dtls_fp: format!("sha-256 {name}"),
        has_app,
        has_voice: false,
        peer_token_sha256: proto::sha256_hex(token.as_bytes()),
        revoked: false,
    });
    let state_path = d.join("trunk-state.json");
    let url = format!("http://{}", t.addr);
    let state = TrunkState::open(Some(state_path.clone()), &url, &t.hub.trunk_key_b64u(), id);
    let tokens = Arc::new(crate::tokens::TokenStore::open_trunk(state.clone()));
    let relay = free_udp_port();
    let wg = crate::wg::start(crate::wg::NodeConfig {
        key_file: d.join("wg.key").to_string_lossy().into(),
        udp: "127.0.0.1:0".into(),
        relay: relay.to_string(),
        http: "127.0.0.1:0".into(),
        brain: Some(fake_brain(name)),
        address: None,
        roots_file: None,
        devices_file: None,
        peer: vec![],
        trunk_state: Some(state_path.to_string_lossy().into()),
        trunk_key: Some(t.hub.trunk_key_b64u()),
    })
    .unwrap();
    let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let echo_addr = echo.local_addr().unwrap();
    std::thread::spawn(move || {
        for s in echo.incoming().flatten() {
            std::thread::spawn(move || {
                let mut s = s;
                let mut buf = [0u8; 4096];
                while let Ok(n) = s.read(&mut buf) {
                    if n == 0 || s.write_all(b"LIVEKIT:").and_then(|_| s.write_all(&buf[..n])).is_err() {
                        break;
                    }
                }
            });
        }
    });
    let dial = Arc::new(crate::ap::DialConfig {
        url: url.clone(),
        pin: String::new(),
        token: String::new(),
        upstream: fake_app(name).to_string(),
        livekit: None,
        tcp: HashMap::from([("livekit-ice".to_string(), echo_addr.to_string())]),
        rootlink: None,
        branch: None,
        tokens,
        ice_demux: None,
    });
    let link = Link::spawn(LinkConfig {
        url,
        pin: None,
        trunk_key: t.hub.trunk_key_b64u(),
        root_id: id.into(),
        root_key: key.clone(),
        state,
        dial,
        wg: Some((relay, wg.udp)),
        ufrags: Arc::default(),
    })
    .unwrap();
    Root { id: id.into(), link, state_path, wg, token, key }
}

fn wg_roots(r: &Root) -> Vec<Value> {
    let (st, body) = get(r.wg.http, "/_wg/_roots", "");
    assert_eq!(st, 200);
    serde_json::from_str::<Value>(&body).unwrap().as_array().cloned().unwrap_or_default()
}

fn stun_binding(receiver: &str) -> Vec<u8> {
    let user = format!("{receiver}:phone");
    let mut attr = vec![0x00, 0x06];
    attr.extend_from_slice(&(user.len() as u16).to_be_bytes());
    attr.extend_from_slice(user.as_bytes());
    while attr.len() % 4 != 0 {
        attr.push(0);
    }
    let mut m = vec![0x00, 0x01];
    m.extend_from_slice(&(attr.len() as u16).to_be_bytes());
    m.extend_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
    m.extend_from_slice(&proto::random_bytes::<12>());
    m.extend_from_slice(&attr);
    let mut f = (m.len() as u16).to_be_bytes().to_vec();
    f.extend_from_slice(&m);
    f
}

#[test]
fn trunk_two_roots_relay_wireguard_directory_revoke() {
    let dir = tmpdir("e2e");
    let t = mini_trunk();
    *t.hub.wg_tap.lock().unwrap() = Some(vec![]);
    let a = root(&t, &dir, "rt_a", "alpha", "10.77.9.2", true);
    let b = root(&t, &dir, "rt_b", "beta", "10.77.9.3", true);
    wait_for("both roots linked", Duration::from_secs(10), || t.hub.online("rt_a") && t.hub.online("rt_b"));

    // the state file: written, 0600, link up, the signed directory with both roots online
    wait_for("state files with both roots online", Duration::from_secs(5), || {
        [&a, &b].iter().all(|r| {
            StateFile::read(&r.state_path).is_some_and(|s| {
                s.link.state == "up" && s.directory["roots"].as_array().is_some_and(|v| v.len() == 2 && v.iter().all(|x| x["online"] == true))
            })
        })
    });
    let sa = StateFile::read(&a.state_path).unwrap();
    assert_eq!((sa.root.id.as_str(), sa.root.name.as_str(), sa.trunk.trunk_id.as_str()), ("rt_a", "alpha", "trk_test"));
    assert_eq!(sa.keys.len(), 1, "the token key came in the signed keys message");
    assert!(sa.directory_roots(&proto::public_from_b64u(&t.hub.trunk_key_b64u()).unwrap()).is_some(), "the directory verifies");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&a.state_path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // 1. a device token relayed to its door root; the trunk's word for a missing one
    t.doors.lock().unwrap().insert("dev_b".into(), "rt_b".into());
    let tok_b = t.token("dev_b", "loopback", 0, 600_000);
    let tok_x = t.token("dev_x", "loopback", 0, 600_000);
    let (st, body) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_b}\r\n"));
    assert_eq!(st, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    // the app gets the real client address in X-Forwarded-For (the edge key only ever goes to the
    // bridge's own listener: /offer, /branch, /identity — ap.rs rewrite_head, unchanged)
    assert_eq!((v["app"].as_str(), v["xff"].as_str(), v["edge"].as_bool()), (Some("beta"), Some("127.0.0.1"), Some(false)), "door rt_b: {v}");
    let (st, body) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_x}\r\n"));
    assert_eq!((st, serde_json::from_str::<Value>(&body).unwrap()["app"].as_str()), (200, Some("alpha")), "no door: the first online root with the app");
    let (st, body) = get(t.addr, "/api/hello", "");
    assert_eq!((st, serde_json::from_str::<Value>(&body).unwrap()), (401, json!({ "why": "missing", "reauth": "login" })));
    // P12 at the trunk: chunked → 411
    let (st, _) = http(t.addr, &format!("POST /api/x HTTP/1.1\r\nHost: t\r\nCookie: bifrost_device={tok_b}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"));
    assert_eq!(st, 411);
    // the root re-checks offline: a revocation the roots heard (the trunk server's own copy here
    // does not deny yet) is refused AT THE ROOT, with C3's words
    t.hub.push_revoke("dev_b", now_ms() + 900_000);
    wait_for("the deny-list reached rt_b", Duration::from_secs(3), || b.link.state().with(|s| s.denied("dev_b", now_ms())));
    let (st, body) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_b}\r\n"));
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!((st, v["why"].as_str(), v["reauth"].as_str()), (401, Some("revoked"), Some("login")), "{v}");
    // a stale kill epoch is refused at the root too
    t.hub.push_kill(1, false);
    wait_for("the kill epoch reached rt_a", Duration::from_secs(3), || a.link.state().with(|s| s.kill_epoch == 1));
    let (st, body) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_x}\r\n"));
    assert_eq!((st, serde_json::from_str::<Value>(&body).unwrap()["why"].as_str()), (401, Some("revoked")));
    let tok_x1 = t.token("dev_x", "loopback", 1, 600_000);
    let (st, _) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_x1}\r\n"));
    assert_eq!(st, 200, "a token of the current epoch passes");

    // 2. the directory reached both wg nodes: each has the other as its one peer, with its token hash
    wait_for("wg peers from the directory", Duration::from_secs(5), || wg_roots(&a).len() == 1 && wg_roots(&b).len() == 1);
    let ra = wg_roots(&a);
    assert_eq!(ra[0]["id"], "rt_b");
    assert_eq!(ra[0]["name"], "beta");
    assert_eq!(ra[0]["peer_token_sha256"].as_str(), Some(proto::sha256_hex(b.token.as_bytes()).as_str()));

    // 3. root ↔ root over WireGuard through the trunk: the brain answers, the trunk saw only ciphertext
    let (st, body) = get(a.wg.http, "/_wg/rt_b/root", &format!("x-ygg-peer: {}\r\n", a.token));
    assert_eq!(st, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!((v["brain"].as_str(), v["from"].as_str(), v["via"].as_str()), (Some("beta"), Some("rt_a"), Some("wg")), "{v}");
    assert_eq!(v["peer"].as_str(), Some(a.token.as_str()), "the caller's own peer token crosses inside the tunnel");
    assert_eq!(v["secret"], MARKER);
    let (st, body) = get(b.wg.http, "/_wg/rt_a/root", "");
    assert_eq!((st, serde_json::from_str::<Value>(&body).unwrap()["brain"].as_str()), (200, Some("alpha")));
    {
        let tap = t.hub.wg_tap.lock().unwrap();
        let frames = tap.as_ref().unwrap();
        assert!(frames.len() >= 4, "the trunk relayed the WireGuard exchange ({} frames)", frames.len());
        for f in frames {
            let (_, d) = crate::wg::unframe(f).expect("a relay frame");
            assert!(crate::wg::wg_kind(d).is_some(), "only WireGuard messages");
            for needle in [MARKER.as_bytes(), b"x-ygg-peer", b"HTTP/1.1", a.token.as_bytes()] {
                assert!(!f.windows(needle.len()).any(|w| w == needle), "plaintext on the trunk");
            }
        }
    }

    // 4. ICE-TCP by registered ufrag: rt_a registers, a framed STUN connection reaches rt_a's
    // `livekit-ice` target; the router's ask answers 200 for it, 404 for an unknown one
    assert!(a.link.register_wait(&["ufragAAAA".to_string()], crate::v1::link::ICE_ACK_WAIT), "ack within 500 ms");
    assert_eq!(t.hub.ice_owner_now("ufragAAAA").as_deref(), Some("rt_a"));
    assert_eq!(get(t.addr, "/t/ice/owner?u=ufragAAAA", "").0, 200);
    assert_eq!(get(t.addr, "/t/ice/owner?u=nobodys1", "").0, 404);
    let mut s = StdTcp::connect(t.ice).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let pkt = stun_binding("ufragAAAA");
    s.write_all(&pkt).unwrap();
    let mut got = vec![0u8; 8 + pkt.len()];
    s.read_exact(&mut got).unwrap();
    assert_eq!(&got[..8], b"LIVEKIT:");
    assert_eq!(&got[8..], &pkt[..]);
    drop(s);
    // a late registration within the 2 s hold is still routed
    let mut s = StdTcp::connect(t.ice).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let pkt = stun_binding("ufragLATE");
    s.write_all(&pkt).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(b.link.register_wait(&["ufragLATE".to_string()], crate::v1::link::ICE_ACK_WAIT));
    let mut got = vec![0u8; 8];
    s.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"LIVEKIT:");
    drop(s);

    // 5. revoke root B: link cut, key refused, directory pushed, A's tunnel to B gone ≤ 1.5 s
    let t0 = Instant::now();
    t.reg.roots.lock().unwrap().iter_mut().find(|r| r.id == "rt_b").unwrap().revoked = true;
    t.hub.root_revoked("rt_b");
    let cut = wait_for("rt_b cut from rt_a's tunnel", Duration::from_millis(1500), || {
        wg_roots(&a).is_empty() && get(a.wg.http, "/_wg/rt_b/root", "").0 != 200
    });
    println!("ROOT REVOKE → WireGuard cut: {} ms", cut.as_millis());
    assert!(t0.elapsed() <= Duration::from_millis(1500), "P13: cut within 1.5 s ({} ms)", t0.elapsed().as_millis());
    assert!(!t.hub.online("rt_b"));
    wait_for("rt_b knows it was revoked", Duration::from_secs(3), || StateFile::read(&b.state_path).is_some_and(|s| s.link.state == "revoked"));
    // its key is refused from then on (a fresh link gets a signed `revoked`)
    std::thread::sleep(Duration::from_millis(1200));
    assert!(!t.hub.online("rt_b"), "a revoked root never links again");
    // the directory the trunk pushed no longer names rt_b
    let sa = StateFile::read(&a.state_path).unwrap();
    assert!(sa.directory["roots"].as_array().unwrap().iter().all(|r| r["id"] != "rt_b"));
    // B's requests no longer go anywhere; A still serves
    let (st, _) = get(t.addr, "/api/hello", &format!("Cookie: bifrost_device={tok_x1}\r\n"));
    assert_eq!(st, 200);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = (a.id, b.id, a.key, b.key);
}

/// The trunk's refusals at `/t/root`: a v0.9 bridge (426), an unknown root, a wrong key.
#[test]
fn root_link_refusals() {
    let dir = tmpdir("refuse");
    let t = mini_trunk();
    // a v0.9 bridge: no proto header, a Bearer → 426 update this computer
    let (st, body) = http(t.addr, "GET /t/root HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\r\n\r\n");
    assert_eq!(st, 426);
    assert!(body.contains("update this computer"), "{body}");
    let (st, _) = http(t.addr, "GET /t/root HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Ygg-Proto: 3\r\n\r\n");
    assert_eq!(st, 426, "another proto");
    // an enrolled root dialing with the wrong key stays down; the right key links
    let good = root(&t, &dir, "rt_k", "kappa", "10.77.9.5", false);
    wait_for("rt_k linked", Duration::from_secs(10), || t.hub.online("rt_k"));
    let fake_state = TrunkState::open(Some(dir.join("fake-state.json")), &format!("http://{}", t.addr), &t.hub.trunk_key_b64u(), "rt_k");
    let fake = Link::spawn(LinkConfig {
        url: format!("http://{}", t.addr),
        pin: None,
        trunk_key: t.hub.trunk_key_b64u(),
        root_id: "rt_k".into(),
        root_key: Arc::new(SignKey::generate()),
        state: fake_state.clone(),
        dial: good.link_dial(),
        wg: None,
        ufrags: Arc::default(),
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!fake.is_up(), "a wrong root key never links");
    assert_ne!(fake_state.snapshot().link.state, "up");
    assert!(good.link.is_up(), "the genuine root keeps its link");
    // a link to a trunk with another key (a front impersonating the trunk) is refused by the root
    let other = mini_trunk();
    let st2 = TrunkState::open(None, &format!("http://{}", other.addr), &t.hub.trunk_key_b64u(), "rt_k");
    let wrong_trunk = Link::spawn(LinkConfig {
        url: format!("http://{}", other.addr),
        pin: None,
        trunk_key: t.hub.trunk_key_b64u(),
        root_id: "rt_k".into(),
        root_key: good.key.clone(),
        state: st2,
        dial: good.link_dial(),
        wg: None,
        ufrags: Arc::default(),
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!wrong_trunk.is_up(), "the root refuses a trunk whose key is not the enrolled one");
    let _ = std::fs::remove_dir_all(&dir);
}

impl Root {
    fn link_dial(&self) -> Arc<crate::ap::DialConfig> {
        self.link.dial()
    }
}
