//! The roots API through the real v1 server (the skeleton's listener and router, an in-memory
//! trunk.db): the installer enrolls, an admin device approves on the desktop card (fresh, same
//! origin), the poll hands the result over once, the root links with it, a device's request goes
//! to it, the headless code and its lockouts, `/t/me/roots`, the door, and the revoke.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::{json, Value};

use crate::v1::crypto::Kek;
use crate::v1::db::{now_ms, Db};
use crate::v1::link::{Link, LinkConfig};
use crate::v1::paseto::{self, Claims};
use crate::v1::proto::{self, SignKey};
use crate::v1::server::{self, State};
use crate::v1::state::{StateFile, TrunkState};

const ORIGIN: &str = "https://trunk.test";

fn tmpdir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("v1-roots-{}-{}", std::process::id(), proto::b64u(&proto::random_bytes::<6>())));
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct T {
    st: Arc<State>,
    addr: SocketAddr,
    dir: std::path::PathBuf,
}

fn trunk() -> T {
    let dir = tmpdir();
    let cfg = crate::v1::config::Config::parse(&format!(
        r#"public_url = "{ORIGIN}"
listen_http = "127.0.0.1:0"
db = "{d}/trunk.db"
state_dir = "{d}"
cred_dir = "{d}"
ctl_socket = "{d}/ctl.sock"
rp_id = "trunk.test"
origins = ["{ORIGIN}"]
"#,
        d = dir.display()
    ))
    .unwrap();
    let st = Arc::new(State::with(cfg, Db::memory(), Kek::from_bytes([9u8; 32])).unwrap());
    st.db.meta_set("claimed_at", &now_ms().to_string()).unwrap();
    st.db
        .with(|c| {
            c.execute("INSERT INTO accounts (id, email, role, created_at) VALUES ('acc_1', 'o@x', 'admin', ?1)", [now_ms()])?;
            for (id, role, fresh) in [("dev_admin", "admin", Some(now_ms())), ("dev_stale", "admin", None), ("dev_member", "member", None)] {
                c.execute(
                    "INSERT INTO devices (id, account_id, role, name, created_via, created_at, last_seen, first_region, last_region, last_2fa_at)
                     VALUES (?1, 'acc_1', ?2, ?1, 'login', ?3, ?3, 'loopback', 'loopback', ?4)",
                    params![id, role, now_ms(), fresh],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let s2 = st.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        rt.block_on(async move {
            let b = server::start(s2).await.unwrap();
            tx.send(b.http.unwrap()).unwrap();
            std::future::pending::<()>().await;
        });
    });
    let addr = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    T { st, addr, dir }
}

impl T {
    fn token(&self, did: &str, role: &str) -> String {
        let now = now_ms() / 1000;
        let c = Claims {
            iss: ORIGIN.into(),
            sub: "acc_1".into(),
            did: did.into(),
            role: role.into(),
            rgn: "loopback".into(),
            kep: 0,
            iat: paseto::fmt_time(now),
            exp: paseto::fmt_time(now + 900),
            jti: proto::b64u(&proto::random_bytes::<16>()),
        };
        paseto::mint(&self.st.signing_key(), &c)
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>, tok: Option<&str>, origin: bool) -> (u16, Value) {
        let mut s = TcpStream::connect(self.addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let b = body.map(|v| v.to_string()).unwrap_or_default();
        let mut h = format!("{method} {path} HTTP/1.1\r\nHost: trunk.test\r\nContent-Length: {}\r\nContent-Type: application/json\r\n", b.len());
        if let Some(t) = tok {
            h.push_str(&format!("Cookie: bifrost_device={t}\r\n"));
        }
        if origin {
            h.push_str(&format!("Origin: {ORIGIN}\r\n"));
        }
        h.push_str("\r\n");
        s.write_all(h.as_bytes()).unwrap();
        s.write_all(b.as_bytes()).unwrap();
        let mut out = vec![];
        let _ = s.read_to_end(&mut out);
        let text = String::from_utf8_lossy(&out).to_string();
        let st = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (st, serde_json::from_str(&body).unwrap_or(Value::String(body)))
    }
}

struct Installer {
    root_key: Arc<SignKey>,
    wg_pub: String,
}

fn installer() -> Installer {
    let k = Arc::new(SignKey::generate());
    let wg: [u8; 32] = proto::random_bytes();
    let secret = boringtun::x25519::StaticSecret::from(wg);
    let public = boringtun::x25519::PublicKey::from(&secret);
    Installer { root_key: k, wg_pub: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public.as_bytes()) }
}

fn enroll_body(i: &Installer, host: &str, has_app: bool) -> Value {
    json!({ "hostname": host, "os": "linux", "arch": "x86_64", "version": "1.0.0", "root_pub": i.root_key.public_b64u(), "wg_pub": i.wg_pub,
            "dtls_fp": "sha-256 AB:CD", "has_app": has_app, "has_voice": false })
}

fn raw_get(addr: SocketAddr, path: &str, tok: Option<&str>) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let c = tok.map(|t| format!("Cookie: bifrost_device={t}\r\n")).unwrap_or_default();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: trunk.test\r\nAccept: text/html\r\n{c}\r\n").as_bytes()).unwrap();
    let mut out = vec![];
    let _ = s.read_to_end(&mut out);
    String::from_utf8_lossy(&out).to_string()
}

fn fake_app(name: &'static str) -> SocketAddr {
    let srv = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = srv.server_addr().to_ip().unwrap();
    std::thread::spawn(move || {
        for rq in srv.incoming_requests() {
            let body = json!({ "app": name, "path": rq.url() }).to_string();
            let _ = rq.respond(tiny_http::Response::from_string(body));
        }
    });
    addr
}

fn link(t: &T, result: &Value, key: &Arc<SignKey>, app: SocketAddr) -> (Arc<Link>, std::path::PathBuf) {
    let id = result["root_id"].as_str().unwrap();
    let trunk_key = result["trunk"]["trunk_key"].as_str().unwrap();
    let state_path = t.dir.join(format!("{id}-state.json"));
    let url = format!("http://{}", t.addr);
    let state = TrunkState::open(Some(state_path.clone()), &url, trunk_key, id);
    let tokens = Arc::new(crate::tokens::TokenStore::open_trunk(state.clone()));
    let dial = Arc::new(crate::ap::DialConfig {
        url: url.clone(),
        pin: String::new(),
        token: String::new(),
        upstream: app.to_string(),
        livekit: None,
        tcp: HashMap::new(),
        rootlink: None,
        branch: None,
        tokens,
        ice_demux: None,
        trunk_link: None,
    });
    let l = Link::spawn(LinkConfig { url, pin: None, trunk_key: trunk_key.into(), root_id: id.into(), root_key: key.clone(), state, dial, wg: None, ufrags: Arc::default() })
        .unwrap();
    (l, state_path)
}

fn wait(what: &str, f: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(10), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn enroll_approve_poll_link_relay_revoke_through_the_server() {
    let t = trunk();
    let admin = t.token("dev_admin", "admin");
    let stale = t.token("dev_stale", "admin");
    let member = t.token("dev_member", "member");
    // signed in, no root yet: no roots, the API answers
    assert_eq!(t.call("GET", "/t/me/roots", None, Some(&admin), false), (200, json!([])));
    assert_eq!(t.call("GET", "/t/state", None, None, false).1["has_roots"], false);
    assert_eq!(t.call("GET", "/t/me/roots", None, None, false), (401, json!({ "why": "missing", "reauth": "login" })));

    // F3: the installer starts; the desktop card; the approval
    let a = installer();
    let (st, start) = t.call("POST", "/t/roots/enroll", Some(&enroll_body(&a, "alpha-box", true)), None, false);
    assert_eq!(st, 200, "{start}");
    let (eid, secret) = (start["id"].as_str().unwrap().to_string(), start["poll_secret"].as_str().unwrap().to_string());
    assert!(start["approve_url"].as_str().unwrap().ends_with(&format!("/auth/root?e={eid}")));
    assert_eq!(start["code"].as_str().unwrap().len(), 6);
    // the same keys again while waiting: 409 (a key enrolled once) — a fresh enrollment replaces it
    let (st, poll) = t.call("POST", &format!("/t/roots/enroll/{eid}/poll"), Some(&json!({ "secret": secret })), None, false);
    assert_eq!((st, poll["status"].as_str()), (200, Some("pending")));
    let (st, _) = t.call("POST", &format!("/t/roots/enroll/{eid}/poll"), Some(&json!({ "secret": "bfne-wrong" })), None, false);
    assert_eq!(st, 404, "the poll secret is the credential");
    let (st, card) = t.call("GET", &format!("/t/roots/enroll/{eid}"), None, Some(&admin), false);
    assert_eq!((st, card["hostname"].as_str(), card["needs_code"].as_bool()), (200, Some("alpha-box"), Some(false)), "{card}");
    assert_eq!(card["wg_fp"].as_str().unwrap().len(), 14);
    let (st, pending) = t.call("GET", "/t/roots/pending", None, Some(&member), false);
    assert_eq!((st, pending.as_array().map(Vec::len)), (200, Some(1)), "any device sees the cards");
    // who may approve: an admin, freshly stepped up, from the trunk's own pages
    let url = format!("/t/roots/enroll/{eid}/approve");
    assert_eq!(t.call("POST", &url, Some(&json!({})), Some(&admin), false).0, 403, "no Origin");
    assert_eq!(t.call("POST", &url, Some(&json!({})), Some(&member), true).0, 403, "a member");
    let (st, r) = t.call("POST", &url, Some(&json!({})), Some(&stale), true);
    assert_eq!((st, r["step_up"].as_bool()), (403, Some(true)), "not fresh");
    let (st, ok) = t.call("POST", &url, Some(&json!({ "name": "Alpha" })), Some(&admin), true);
    assert_eq!(st, 200, "{ok}");
    let root_a = ok["root_id"].as_str().unwrap().to_string();
    assert!(root_a.starts_with("rt_"));
    assert_eq!(t.call("POST", &url, Some(&json!({})), Some(&admin), true).0, 409, "approved once");
    // the poll hands the result over once (sealed in the DB until then)
    let sealed: Option<Vec<u8>> = t.st.db.with(|c| c.query_row("SELECT result_enc FROM enrollments WHERE id = ?1", [&eid], |r| r.get(0))).unwrap();
    assert!(sealed.as_ref().is_some_and(|b| !String::from_utf8_lossy(b).contains("ygp-")), "kept sealed, never the raw token");
    let (st, result) = t.call("POST", &format!("/t/roots/enroll/{eid}/poll"), Some(&json!({ "secret": secret })), None, false);
    assert_eq!((st, result["status"].as_str(), result["root_id"].as_str()), (200, Some("approved"), Some(root_a.as_str())), "{result}");
    assert!(result["peer_token"].as_str().unwrap().starts_with("ygp-"));
    assert_eq!(result["trunk"]["trunk_id"].as_str(), Some(t.st.trunk_id.as_str()));
    assert!(proto::verify_directory(&proto::public_from_b64u(result["trunk"]["trunk_key"].as_str().unwrap()).unwrap(), &result["directory"]).is_some());
    let (st, again) = t.call("POST", &format!("/t/roots/enroll/{eid}/poll"), Some(&json!({ "secret": secret })), None, false);
    assert_eq!((st, again["status"].as_str()), (410, Some("delivered")));
    let peer_hash: String = t.st.db.with(|c| c.query_row("SELECT peer_token_hash FROM roots WHERE id = ?1", [&root_a], |r| r.get(0))).unwrap();
    assert_eq!(peer_hash, proto::sha256_hex(result["peer_token"].as_str().unwrap().as_bytes()), "only the hash is kept");
    // the keys are enrolled now: never again
    assert_eq!(t.call("POST", "/t/roots/enroll", Some(&enroll_body(&a, "alpha-box", true)), None, false).0, 409);

    // the root links with what it got; a device's request reaches its app
    let (la, state_a) = link(&t, &result, &a.root_key, fake_app("alpha"));
    wait("alpha linked", || la.is_up());
    let (st, roots) = t.call("GET", "/t/me/roots", None, Some(&admin), false);
    assert_eq!(st, 200);
    assert_eq!(roots, json!([{ "id": root_a, "name": "alpha", "online": true, "has_app": true, "has_voice": false, "dtls_fp": "sha-256 AB:CD", "door": true }]));
    let (st, hello) = t.call("GET", "/api/hello", None, Some(&admin), false);
    assert_eq!((st, hello["app"].as_str(), hello["path"].as_str()), (200, Some("alpha"), Some("/api/hello")), "{hello}");
    wait("alpha's state file: up, its name", || StateFile::read(&state_a).is_some_and(|s| s.link.state == "up" && s.root.name == "alpha"));

    // F4: headless — the code on the installer's screen, entered on an admin device
    let b = installer();
    let (_, sb) = t.call("POST", "/t/roots/enroll", Some(&enroll_body(&b, "beta-headless", false)), None, false);
    let (eb, code) = (sb["id"].as_str().unwrap().to_string(), sb["code"].as_str().unwrap().to_string());
    let wrong = if code == "000000" { "000001" } else { "000000" };
    let (st, miss) = t.call("POST", "/t/roots/enroll/by-code", Some(&json!({ "code": wrong })), Some(&admin), true);
    assert_eq!((st, miss["left"].as_i64()), (404, Some(9)));
    let (st, found) = t.call("POST", "/t/roots/enroll/by-code", Some(&json!({ "code": code })), Some(&admin), true);
    assert_eq!((st, found["id"].as_str()), (200, Some(eb.as_str())));
    // a wrong code on the card counts against the enrollment: 5 kill it
    let burn = installer();
    let (_, sc) = t.call("POST", "/t/roots/enroll", Some(&enroll_body(&burn, "gamma", false)), None, false);
    let ec = sc["id"].as_str().unwrap().to_string();
    let code_c = sc["code"].as_str().unwrap().to_string();
    let wrong_c = if code_c == "999999" { "999998" } else { "999999" };
    let url_c = format!("/t/roots/enroll/{ec}/approve");
    for i in 1..=4 {
        let (st, r) = t.call("POST", &url_c, Some(&json!({ "code": wrong_c })), Some(&admin), true);
        assert_eq!(st, 403, "wrong code #{i}: {r}");
    }
    let (st, _) = t.call("POST", &url_c, Some(&json!({ "code": wrong_c })), Some(&admin), true);
    assert_eq!(st, 410, "the 5th wrong code ends the enrollment");
    assert_eq!(t.call("POST", &url_c, Some(&json!({ "code": code_c })), Some(&admin), true).0, 409, "over, even with the right code");
    // the right code approves the headless one
    let (st, okb) = t.call("POST", &format!("/t/roots/enroll/{eb}/approve"), Some(&json!({ "code": code })), Some(&admin), true);
    assert_eq!(st, 200, "{okb}");
    let root_b = okb["root_id"].as_str().unwrap().to_string();
    // 10 wrong per account per hour lock code entry (1 wrong by-code + 5 on gamma so far = 6)
    for _ in 0..3 {
        assert_eq!(t.call("POST", "/t/roots/enroll/by-code", Some(&json!({ "code": wrong })), Some(&admin), true).0, 404);
    }
    let (st, locked) = t.call("POST", "/t/roots/enroll/by-code", Some(&json!({ "code": wrong })), Some(&admin), true);
    assert_eq!(st, 429, "the 10th wrong code this hour locks: {locked}");
    let (st, _) = t.call("POST", "/t/roots/enroll/by-code", Some(&json!({ "code": code })), Some(&admin), true);
    assert_eq!(st, 429, "locked for the hour, even the right code");

    // the door: beta runs no app — it cannot be one; alpha can
    assert_eq!(t.call("PUT", "/t/me/door", Some(&json!({ "root_id": root_b })), Some(&admin), true).0, 400);
    assert_eq!(t.call("PUT", "/t/me/door", Some(&json!({ "root_id": root_a })), Some(&admin), true).0, 200);
    assert_eq!(t.call("PUT", "/t/me/door", Some(&json!({ "root_id": root_a })), Some(&admin), false).0, 403, "a write needs the Origin");
    let (_, list) = t.call("GET", "/t/roots", None, Some(&member), false);
    assert_eq!(list.as_array().map(Vec::len), Some(2));
    // rename (admin), revoke (admin; a member cannot)
    assert_eq!(t.call("PATCH", &format!("/t/roots/{root_a}"), Some(&json!({ "name": "Alpha Main" })), Some(&admin), true).1["name"], "alpha-main");
    assert_eq!(t.call("DELETE", &format!("/t/roots/{root_a}"), None, Some(&member), true).0, 403);
    let t0 = Instant::now();
    assert_eq!(t.call("DELETE", &format!("/t/roots/{root_a}"), None, Some(&admin), true).0, 200);
    wait("alpha revoked", || StateFile::read(&state_a).is_some_and(|s| s.link.state == "revoked") && !la.is_up());
    println!("DELETE /t/roots/:id → the root's link revoked in {} ms", t0.elapsed().as_millis());
    let (_, roots) = t.call("GET", "/t/me/roots", None, Some(&admin), false);
    assert!(roots.as_array().unwrap().iter().all(|r| r["id"] != root_a.as_str()));
    // no door left (beta runs no app, and is offline): the device lands on /offline
    let (st, off) = t.call("GET", "/api/hello", None, Some(&admin), false);
    assert_eq!((st, off["why"].as_str()), (503, Some("offline")), "{off}");
    assert_eq!(t.call("DELETE", &format!("/t/roots/{root_a}"), None, Some(&admin), true).0, 404, "once");
    // the pages: signed in → the card's page and its script (CSP, no inline script); else /login
    let page = raw_get(t.addr, &format!("/auth/root?e={eid}"), Some(&admin));
    assert!(page.starts_with("HTTP/1.1 200") && page.contains("Connect root") && page.contains("/t/roots/ui.js"), "{}", &page[..page.len().min(300)]);
    assert!(page.to_ascii_lowercase().contains("content-security-policy: default-src 'self'"), "the shell CSP");
    assert!(!page.contains("<script>"), "no inline script");
    let anon = raw_get(t.addr, "/add-root", None);
    assert!(anon.starts_with("HTTP/1.1 302") && anon.to_ascii_lowercase().contains("location: /login?next=/add-root"), "{}", &anon[..anon.len().min(300)]);
    let js = raw_get(t.addr, "/t/roots/ui.js", None);
    assert!(js.starts_with("HTTP/1.1 200") && js.contains("/t/roots/enroll/by-code"));
    // the router's question is answered only to ice_owner_from (none configured here)
    assert_eq!(t.call("GET", "/t/ice/owner?u=abcd", None, None, false).0, 403);
    // a v0.9 bridge dialing /t/root
    let (st, _) = t.call("GET", "/t/root", None, None, false);
    assert_eq!(st, 426);
    let _ = std::fs::remove_dir_all(&t.dir);
}

#[test]
fn enroll_limits_and_input_cleaning() {
    let t = trunk();
    let bad = installer();
    let mut body = enroll_body(&bad, "x y", false);
    assert_eq!(t.call("POST", "/t/roots/enroll", Some(&body), None, false).0, 400, "hostname cleaned");
    body["hostname"] = json!("ok-host");
    body["wg_pub"] = json!("not-a-key");
    assert_eq!(t.call("POST", "/t/roots/enroll", Some(&body), None, false).0, 400, "wg_pub checked");
    body["wg_pub"] = json!(bad.wg_pub);
    body["root_pub"] = json!("short");
    assert_eq!(t.call("POST", "/t/roots/enroll", Some(&body), None, false).0, 400, "root_pub checked");
    // 5 per 10 minutes per address: the window counts every attempt, refused ones too (roots.ts
    // takes it first as well) — 3 above, 2 more pass, then 429
    let mut codes = vec![];
    for i in 0..3 {
        let n = installer();
        codes.push(t.call("POST", "/t/roots/enroll", Some(&enroll_body(&n, &format!("h{i}"), false)), None, false).0);
    }
    assert_eq!(codes, vec![200, 200, 429], "5 per 10 minutes per address");
    let _ = std::fs::remove_dir_all(&t.dir);
}
