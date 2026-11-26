//! import-v0 + rebind (spec §11 steps 2/7, A6): a v0.9 trunk's `roots.json` and
//! `bridge-dtls.json` brought into v1, and a v0.9-joined root binding its new key with its old
//! root secret — no approval anywhere.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{rebind_input, REBIND_CTX};
use crate::v1::db::{now_ms, Db};
use crate::v1::crypto::Kek;
use crate::v1::server::State;
use crate::v1::{paseto, proto};
use std::sync::Arc;

const ORIGIN: &str = "https://trunk.test";

fn tmpdir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("v1-import-{}-{}", std::process::id(), proto::b64u(&proto::random_bytes::<6>())));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A state around an in-memory db (roots/tests.rs's `trunk()` shape, minimal).
fn state() -> (Arc<State>, std::path::PathBuf) {
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
    (st, dir)
}

/// A v0.9 roots.json: the hub ("omarchy") + two joined roots with their old secret hashes.
fn v0_files(dir: &PathBuf) -> (PathBuf, PathBuf, [String; 2]) {
    let s1 = "v0-secret-alpha-0123456789";
    let s2 = "v0-secret-beta-9876543210";
    let roots = json!({
        "wg": { "net": "10.77.0.0/24" },
        "roots": [
            { "id": "alpha", "name": "alpha", "host": "alpha-box", "os": "linux", "wg_pub": "", "wg_ip": "10.77.0.2",
              "secretHash": sha256_hex(s1), "share_model": true, "joined_at": 1700000000000u64, "dev": "dev_x", "delivered_at": 1700000000000u64 },
            { "id": "beta", "name": "beta", "host": "beta-box", "os": "linux", "wg_pub": "", "wg_ip": "10.77.0.3",
              "secretHash": sha256_hex(s2), "share_model": true, "joined_at": 1700000001000u64, "dev": "dev_y", "delivered_at": 1700000001000u64 }
        ]
    });
    let rp = dir.join("roots.json");
    std::fs::write(&rp, roots.to_string()).unwrap();
    // bridge-dtls.json: a DER the pin is computed from (any bytes: the test only needs the shape)
    let der: Vec<u8> = (0..64u8).collect();
    use base64::Engine as _;
    let dtls = dir.join("bridge-dtls.json");
    std::fs::write(&dtls, json!({ "certificate": base64::engine::general_purpose::STANDARD.encode(der) }).to_string()).unwrap();
    (rp, dtls, [s1.to_string(), s2.to_string()])
}

fn sha256_hex(s: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}


fn new_wg_pub(seed: u8) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode([seed; 32])
}

#[test]
fn import_v0_and_rebind_end_to_end() {
    let (st, dir) = state();
    let (roots_path, dtls_path, secrets) = v0_files(&dir);
    // fix wg_pubs (the const ones above may be wrong length)
    let mut roots_json: Value = serde_json::from_str(&std::fs::read_to_string(&roots_path).unwrap()).unwrap();
    roots_json["roots"][0]["wg_pub"] = json!(new_wg_pub(1));
    roots_json["roots"][1]["wg_pub"] = json!(new_wg_pub(2));
    std::fs::write(&roots_path, roots_json.to_string()).unwrap();

    // the hub's new key (hub-units.sh --prepare makes it)
    let hub_key = proto::SignKey::generate();
    let args: Vec<String> = [
        "--roots", roots_path.to_str().unwrap(),
        "--dtls", dtls_path.to_str().unwrap(),
        "--hub-name", "omarchy",
        "--hub-wg-pub", &new_wg_pub(9),
        "--hub-root-pub", &hub_key.public_b64u(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let out = super::import_v0(&st, &args).unwrap();
    assert!(out.contains("omarchy"), "{out}");

    // the hub root is in, with its NEW key and the computed pin; joined roots wait for a rebind
    let hub: (String, String, String, Option<String>) = st
        .db
        .with(|c| c.query_row("SELECT id, root_pub, dtls_fp, rebind_secret_hash FROM roots WHERE id = 'omarchy'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))))
        .unwrap();
    assert_eq!(hub.0, "omarchy");
    assert_eq!(hub.1, hub_key.public_b64u());
    assert!(hub.2.starts_with("sha-256 "), "the pin from bridge-dtls.json: {}", hub.2);
    assert!(hub.3.is_none(), "the hub needs no rebind");
    let n: i64 = st.db.with(|c| c.query_row("SELECT COUNT(*) FROM roots", [], |r| r.get(0))).unwrap();
    assert_eq!(n, 3, "hub + alpha + beta");
    let alpha: (String, String, String) = st
        .db
        .with(|c| c.query_row("SELECT root_pub, wg_addr, rebind_secret_hash FROM roots WHERE id = 'alpha'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))))
        .unwrap();
    assert!(alpha.0.starts_with("unbound:"), "no link key until the rebind: {alpha:?}");
    assert_eq!(alpha.1, "10.77.0.2", "the v0.9 address is kept (A6)");
    assert_eq!(alpha.2, sha256_hex(&secrets[0]));

    // import-v0 twice: refused
    assert!(super::import_v0(&st, &args).is_err(), "runs once");

    // a bad roots.json: refused with the reason
    let mut bad = roots_json.clone();
    bad["roots"][0]["secretHash"] = json!("xyz");
    let bp = dir.join("bad-roots.json");
    std::fs::write(&bp, bad.to_string()).unwrap();
    let mut bad_args = args.clone();
    *bad_args.iter_mut().find(|a| *a == roots_path.to_str().unwrap()).unwrap() = bp.to_str().unwrap().to_string();
    let e = super::import_v0(&st, &bad_args).unwrap_err();
    assert!(e.contains("secretHash") || e.contains("already"), "{e}");

    // rebind: alpha's NEW key signs its OLD secret
    let alpha_key = proto::SignKey::generate();
    let sig = alpha_key.sign(&rebind_input("alpha", &secrets[0]));
    let body = json!({ "root_id": "alpha", "old_secret": secrets[0], "root_pub": alpha_key.public_b64u(), "sig": proto::b64u(&sig) });
    let (code, r) = rebind_call(&st, &body);
    assert_eq!((code, r["bound"].as_str()), (200, Some("alpha")), "{r}");
    let now_pub: String = st
        .db
        .with(|c| c.query_row("SELECT root_pub FROM roots WHERE id = 'alpha'", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(now_pub, alpha_key.public_b64u());
    let burned: Option<String> = st
        .db
        .with(|c| c.query_row("SELECT rebind_secret_hash FROM roots WHERE id = 'alpha'", [], |r| r.get(0)))
        .unwrap();
    assert!(burned.is_none(), "the secret is burned on use");

    // the burned secret cannot rebind another key, and a wrong secret never worked
    let thief = proto::SignKey::generate();
    let sig2 = thief.sign(&rebind_input("alpha", &secrets[0]));
    let (code, r) = rebind_call(&st, &json!({ "root_id": "alpha", "old_secret": secrets[0], "root_pub": thief.public_b64u(), "sig": proto::b64u(&sig2) }));
    assert_eq!(code, 410, "{r}: the secret is gone");
    let sig3 = proto::SignKey::generate().sign(&rebind_input("beta", "wrong-secret-wrong-secret"));
    let (code, r) = rebind_call(&st, &json!({ "root_id": "beta", "old_secret": "wrong-secret-wrong-secret", "root_pub": proto::SignKey::generate().public_b64u(), "sig": proto::b64u(&sig3) }));
    assert_eq!((code, r["error"].as_str().is_some()), (401, true), "{r}");
    // a key that did not sign the old secret: the signature itself fails first
    let (code, r) = rebind_call(&st, &json!({ "root_id": "beta", "old_secret": secrets[1], "root_pub": thief.public_b64u(), "sig": proto::b64u(&sig2) }));
    assert_eq!(code, 401, "{r}");

    // beta rebinds properly, then dials /t/root with the bound key: the normal handshake
    let beta_key = proto::SignKey::generate();
    let sig4 = beta_key.sign(&rebind_input("beta", &secrets[1]));
    let (code, _) = rebind_call(&st, &json!({ "root_id": "beta", "old_secret": secrets[1], "root_pub": beta_key.public_b64u(), "sig": proto::b64u(&sig4) }));
    assert_eq!(code, 200);

    // the audit chain has one entry per root import + one rebind each
    let entries: Vec<Value> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT action, target_kind, target_id FROM audit ORDER BY seq")?;
            let v = s
                .query_map([], |r| Ok(json!({ "action": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "id": r.get::<_, String>(2)? })))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap();
    let imports: Vec<&Value> = entries.iter().filter(|e| e["action"] == "root.import").collect();
    assert_eq!(imports.len(), 3, "one audit entry per root: {entries:?}");
    assert!(imports.iter().all(|e| e["kind"] == "root"));
    assert_eq!(entries.iter().filter(|e| e["action"] == "root.rebind").count(), 2);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = (REBIND_CTX, paseto::fmt_time(0));
}

/// POST /t/roots/rebind: the handler over a duplex stream (the same bytes a root sends).
fn rebind_call(st: &Arc<State>, body: &Value) -> (u16, Value) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (_client, server) = tokio::io::duplex(64 * 1024);
        let text = format!("POST /t/roots/rebind HTTP/1.1\r\nHost: t\r\nContent-Length: {}\r\n\r\n{}", body.to_string().len(), body.to_string());
        let mut io = Box::new(server) as Box<dyn crate::v1::http::Io>;
        let head: Vec<u8> = text.split("\r\n\r\n").next().unwrap().as_bytes().to_vec();
        let rest = text.as_bytes()[head.len() + 4..].to_vec();
        let req = crate::v1::http::parse_head(&head).expect("head");
        let mut inc = crate::v1::server::Incoming {
            io, head, rest, req,
            peer: "127.0.0.1:9".parse().unwrap(),
            ip: "127.0.0.1".parse().unwrap(),
            tls: false,
        };
        let r = super::rebind(st, &mut inc).await;
        drop(inc); // the server half ends: no half-open duplex
        let out = String::from_utf8_lossy(&r.bytes(false)).to_string();
        let code = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let bod = out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (code, serde_json::from_str(&bod).unwrap_or(Value::String(bod)))
    })
}
