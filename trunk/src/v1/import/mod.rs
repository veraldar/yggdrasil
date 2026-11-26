//! `import-v0` (spec §11 steps 2 and 7) and `POST /t/roots/rebind` (§7): bringing a v0.9 trunk's
//! roots into v1 with **no re-approval**, and letting each v0.9-joined root bind its new root key
//! with its old root secret.
//!
//! import-v0 (console = admin, one audit entry per root, W8 data rule — the v0.9 files are read,
//! never written):
//!   * the hub root: `--hub-name` (its `YGG_ROOT_NAME`, becomes its v1 id per A6), `--hub-wg-pub`
//!     (from `wg-hub.key.pub`), `--hub-dtls-fp` (its DTLS pin, "sha-256 AB:…"), `--hub-root-pub`
//!     (the NEW Ed25519 root key `hub-units.sh switch-v1 --prepare` made). It gets the first
//!     WireGuard address and keeps the v0.9 net from roots.json (`wg.net`, so nothing renumbers).
//!   * every joined root from `roots.json`: its id (kept as-is, A6), name, host, os, wg_pub,
//!     wg_ip, and `secretHash` → `rebind_secret_hash` (burned by that root's one rebind).
//!     `share_model` → `share_model_from` = the hub's id.
//!
//! rebind `{"root_id","old_secret","root_pub","sig"}` (no cookie — the root proves itself):
//!   * `sig` = Ed25519(root_pub) over `"ygg-trunk-v1/rebind\0" root_id "\0" old_secret` — the new
//!     key must sign the old secret, so a copied root_pub without the secret cannot take the id;
//!   * `sha256(old_secret)` must equal the root's `rebind_secret_hash` (a v0.9 root that already
//!     enrolled fresh has none → 410 "already bound");
//!   * on match: `root_pub` is written as the root's link key, `rebind_secret_hash` is burned
//!     (NULL), the signed directory is pushed, and one audit entry is written. Idempotent re-dial
//!     with the same key is the normal `/t/root` handshake after that.

use std::net::IpAddr;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::crypto;
use super::db::now_ms;
use super::http::Resp;
use super::proto;
use super::relay::Hub;
use super::server::State;

pub const REBIND_CTX: &str = "ygg-trunk-v1/rebind";

/* ------------------------------------------------------------------ import-v0 (console) */

struct V0Root {
    id: String,
    name: String,
    host: String,
    os: String,
    wg_pub: String,
    wg_ip: String,
    secret_hash: String,
    share_model: bool,
}

fn read_v0_roots(path: &str) -> Result<(String, Vec<V0Root>), String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| format!("--roots {path}: {e}"))?)
        .map_err(|e| format!("--roots {path}: not JSON: {e}"))?;
    let net = v["wg"]["net"].as_str().ok_or_else(|| format!("--roots {path}: no wg.net (a v0.9 roots.json)"))?
        .trim().to_string();
    let net_ok = net
        .strip_suffix("/24")
        .and_then(|b| b.parse::<IpAddr>().ok())
        .map(|a| matches!(a, IpAddr::V4(ip) if ip.octets()[3] == 0))
        .unwrap_or(false);
    if !net_ok {
        return Err(format!("--roots {path}: wg.net {net:?} is not a /24 (import keeps v0.9's addressing)"));
    }
    let mut out = vec![];
    for (i, r) in v["roots"].as_array().into_iter().flatten().enumerate() {
        let (id, name) = (r["id"].as_str().unwrap_or_default(), r["name"].as_str().unwrap_or_default());
        let get = |k: &str| r[k].as_str().unwrap_or_default();
        if !crate::wg::valid_addr(id) || id.len() > 60 {
            return Err(format!("--roots {path}: roots[{i}] id {id:?} is not a root id import can keep"));
        }
        let (wg_pub, wg_ip, secret_hash) = (get("wg_pub"), get("wg_ip"), get("secretHash"));
        let Ok(key) = crate::wg::decode_key(wg_pub) else {
            return Err(format!("--roots {path}: roots[{i}] ({id}) wg_pub is not a base64 WireGuard key"));
        };
        let wg_pub = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key);
        if wg_ip.parse::<IpAddr>().is_err() || !wg_ip.starts_with(net.trim_end_matches("0/24")) {
            return Err(format!("--roots {path}: roots[{i}] ({id}) wg_ip {wg_ip:?} is outside {net}"));
        }
        if secret_hash.len() != 64 || !secret_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("--roots {path}: roots[{i}] ({id}) secretHash is not a sha256 hex"));
        }
        out.push(V0Root {
            id: id.to_string(),
            name: (if name.is_empty() { id } else { name }).to_string(),
            host: get("host").chars().take(64).collect(),
            os: get("os").chars().take(16).collect(),
            wg_pub,
            wg_ip: wg_ip.to_string(),
            secret_hash: secret_hash.to_ascii_lowercase(),
            share_model: r["share_model"].as_bool().unwrap_or(false),
        });
    }
    Ok((net, out))
}

/// The hub's DTLS pin from `bridge-dtls.json`: the sha-256 of the DER certificate, in the app's
/// `sha-256 AB:CD:…` pin form (branch/lib/pinned.ts), so the phone's existing pin keeps matching.
fn dtls_pin_from_cert(path: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| format!("--dtls {path}: {e}"))?)
        .map_err(|e| format!("--dtls {path}: not JSON: {e}"))?;
    let b64 = v["certificate"].as_str().ok_or_else(|| format!("--dtls {path}: no certificate (a v0.9 bridge-dtls.json)"))?;
    use base64::Engine as _;
    let der = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("--dtls {path}: certificate: {e}"))?;
    use sha2::Digest as _;
    let h = sha2::Sha256::digest(&der);
    let hex: String = h.iter().map(|b| format!("{b:02X}")).collect();
    Ok(format!("sha-256 {}", hex.as_bytes().chunks(2).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join(":")))
}

/// `trunk-ctl import-v0` (console = admin). Reads the v0.9 files, never writes them. Every root
/// gets one audit entry; the hub root is enrolled directly (its new key is trusted because the
/// console — root on the box — supplied it), joined roots wait for their rebind.
fn hub_of(st: &Arc<State>) -> &Arc<Hub> {
    super::relay::hub(st)
}

pub fn import_v0(st: &Arc<State>, args: &[String]) -> Result<String, String> {
    let mut roots_path = None;
    let mut dtls_path = None;
    let mut hub_name = None;
    let mut hub_wg_pub = None;
    let mut hub_dtls_fp = None;
    let mut hub_root_pub = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut v = || it.next().cloned().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "--roots" => roots_path = Some(v()?),
            "--dtls" => dtls_path = Some(v()?),
            "--hub-name" => hub_name = Some(v()?),
            "--hub-wg-pub" => hub_wg_pub = Some(v()?),
            "--hub-dtls-fp" => hub_dtls_fp = Some(v()?),
            "--hub-root-pub" => hub_root_pub = Some(v()?),
            other => return Err(format!("import-v0: unknown flag {other:?}")),
        }
    }
    let (net, mut roots) = read_v0_roots(roots_path.as_deref().ok_or("import-v0: --roots <roots.json>")?)?;
    let hub_name = crate::v1::roots::clean_name(&hub_name.ok_or("import-v0: --hub-name (the hub's YGG_ROOT_NAME)")?)
        .ok_or("--hub-name: 1-40 of a-z 0-9 -")?;
    let hub_wg_pub = hub_wg_pub.ok_or("import-v0: --hub-wg-pub (wg-hub.key.pub)")?;
    let hub_key = crate::wg::decode_key(&hub_wg_pub).map_err(|_| "--hub-wg-pub: not a base64 WireGuard public key")?;
    let hub_wg_pub = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hub_key);
    let hub_root_pub = proto::public_from_b64u(&hub_root_pub.ok_or("import-v0: --hub-root-pub (the new root key hub-units.sh --prepare made)")?)
        .ok_or("--hub-root-pub: not a b64url Ed25519 public key")?;
    // --dtls gives the hub's pin from bridge-dtls.json; --hub-dtls-fp may carry it directly
    let hub_dtls_fp = match (hub_dtls_fp.as_deref(), dtls_path.as_deref()) {
        (Some(fp), _) => {
            if !crate::v1::roots::dtls_fp_ok(fp) {
                return Err("--hub-dtls-fp: \"sha-256 AB:CD…\"".into());
            }
            fp.trim().to_string()
        }
        (None, Some(p)) => dtls_pin_from_cert(p)?,
        (None, None) => return Err("import-v0: --dtls <bridge-dtls.json> or --hub-dtls-fp <pin>".into()),
    };
    let now = now_ms();
    let n_roots = roots.len();
    let joined_ids: Vec<String> = roots.iter().map(|r| r.id.clone()).collect();
    let hub_addr = format!("{}.1", net.trim_end_matches(".0/24"));
    let db_err = |e: rusqlite::Error| e.to_string();
    st.db.with_tx(|c| {
        let tx = c.transaction().map_err(db_err)?;
        // the v0.9 net is kept exactly (no renumbering: existing WireGuard configs stay valid)
        let had_net: Option<String> = tx.query_row("SELECT v FROM meta WHERE k = 'wg_net'", [], |r| r.get(0)).optional().map_err(db_err)?;
        match had_net {
            Some(had) if had != net => return Err(format!("this trunk already has a WireGuard net ({had}); import-v0 keeps v0.9's {net} — refusing to renumber")),
            Some(_) => {}
            None => { tx.execute("INSERT INTO meta (k, v) VALUES ('wg_net', ?1)", [&net]).map_err(db_err)?; }
        }
        // the hub root: enrolled directly with its NEW key (the console supplied it on the box)
        let hub_taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE id = ?1 OR wg_pub = ?2 OR root_pub = ?3)", params![hub_name, hub_wg_pub, proto::b64u(&hub_root_pub)], |r| r.get(0)).map_err(db_err)?;
        if hub_taken {
            return Err(format!("a root with the hub's name or keys is already in this trunk (import-v0 runs once; trunk-ctl roots list)"));
        }
        let addr_taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE wg_addr = ?1)", [&hub_addr], |r| r.get::<_, bool>(0)).map_err(db_err)?;
        if addr_taken {
            return Err(format!("{hub_addr} is already another root's address"));
        }
        tx.execute(
            "INSERT INTO roots (id, name, hostname, os, arch, version, build_id, has_app, has_voice, root_pub, wg_pub, wg_addr, dtls_fp,
                                peer_token_hash, share_model_from, enrolled_by_device, enrolled_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, 'x86_64', 'import-v0', '', 1, 1, ?5, ?6, ?7, ?8, ?9, ?1, 'console', ?10, ?10)",
            params![hub_name, hub_name, hub_name, std::env::consts::OS, proto::b64u(&hub_root_pub), hub_wg_pub, hub_addr, hub_dtls_fp,
                    crypto::sha256_hex(&crypto::secret("ygp-", 32).as_bytes()), now],
        ).map_err(db_err)?;
        // every joined root: id and keys kept, its v0.9 secret hash kept for its one rebind
        for r in roots.drain(..) {
            let taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE id = ?1 OR wg_pub = ?2 OR wg_addr = ?3)", params![r.id, r.wg_pub, r.wg_ip], |r| r.get(0)).map_err(db_err)?;
            if taken {
                return Err(format!("root {} ({} {}) is already in this trunk — import-v0 runs once", r.id, r.wg_ip, r.name));
            }
            tx.execute(
                "INSERT INTO roots (id, name, hostname, os, arch, version, build_id, has_app, has_voice, root_pub, wg_pub, wg_addr, dtls_fp,
                                    peer_token_hash, share_model_from, rebind_secret_hash, enrolled_by_device, enrolled_at)
                 VALUES (?1, ?2, ?3, ?4, 'unknown', 'import-v0', '', 0, 0, ?11, ?5, ?6, '', ?7, ?8, ?9, 'import-v0', ?10)",
                params![
                    r.id, r.name, r.host, r.os, r.wg_pub, r.wg_ip,
                    crypto::sha256_hex(&crypto::secret("ygp-", 32).as_bytes()),
                    r.share_model.then_some(hub_name.clone()), r.secret_hash, now,
                    format!("unbound:{}", r.id)  // never a valid b64url key: no link until the rebind
                ],
            ).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    })?;
    // one audit entry per root (the hub's names the whole import)
    super::idp::audit(&st, super::idp::audit::Entry::new("root.import").target("root", &hub_name)
        .detail(json!({ "via": "import-v0", "role": "hub", "wg_addr": hub_addr, "roots": n_roots })));
    for id in &joined_ids {
        super::idp::audit(&st, super::idp::audit::Entry::new("root.import").target("root", id)
            .detail(json!({ "via": "import-v0", "rebind": true, "wg_addr": wg_ip_of(&st, id) })));
    }
    Ok(format!(
        "imported: {hub_name} (the hub, new key bound) + {n_roots} v0.9 joined root(s) from {net}; each one rebinds with POST /t/roots/rebind after root.sh --update --major"
    ))
}

fn wg_ip_of(st: &Arc<State>, id: &str) -> String {
    st.db.with(|c| c.query_row("SELECT wg_addr FROM roots WHERE id = ?1", [id], |r| r.get(0))).unwrap_or_default()
}

/// `trunk-ctl roots list` (spec §7 console): the same rows the API serves, plus the import state.
pub fn roots_list(st: &Arc<State>) -> Result<String, String> {
    let rows: Vec<Value> = st.db.with(|c| {
        let mut s = c.prepare(
            "SELECT id, name, hostname, os, wg_addr, dtls_fp, has_app, has_voice, rebind_secret_hash IS NOT NULL, revoked_at, enrolled_at, last_seen
             FROM roots ORDER BY enrolled_at, id",
        )?;
        let v = s.query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(json!({
                "id": id, "name": r.get::<_, String>(1)?, "hostname": r.get::<_, String>(2)?,
                "os": r.get::<_, String>(3)?, "wg_addr": r.get::<_, String>(4)?, "dtls_fp": r.get::<_, String>(5)?,
                "has_app": r.get::<_, i64>(6)? != 0, "has_voice": r.get::<_, i64>(7)? != 0,
                "needs_rebind": r.get::<_, i64>(8)? != 0, "revoked": r.get::<_, Option<i64>>(9)?.is_some(),
                "enrolled_at": r.get::<_, i64>(10)?, "last_seen": r.get::<_, Option<i64>>(11)?,
            }))
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }).map_err(|e: String| e)?;
    let hub = hub_of(st);
    let lines: Vec<String> = rows.into_iter().map(|mut v| {
        v["online"] = json!(hub.online(v["id"].as_str().unwrap_or_default()));
        v.to_string()
    }).collect();
    Ok(lines.join("\n"))
}

/// `trunk-ctl roots revoke ID [WHY..]`: cuts the link and pushes the directory (P13) like the API
/// route. No `Who` (the console is the admin's last resort) — an audit entry names it.
pub fn roots_revoke(st: &Arc<State>, id: &str, why: &str) -> Result<String, String> {
    let now = now_ms();
    let n = st.db.with(|c| c.execute("UPDATE roots SET revoked_at = ?1, revoked_by = 'console', revoked_why = ?2 WHERE id = ?3 AND revoked_at IS NULL", params![now, why, id])).unwrap_or(0);
    if n == 0 {
        return Err(format!("roots revoke: no such root (or already revoked): {id}"));
    }
    let _ = st.db.with(|c| c.execute("UPDATE devices SET door_root = NULL WHERE door_root = ?1", [id]));
    super::idp::audit(&st, super::idp::audit::Entry::new("root.revoke").target("root", id).detail(json!({ "why": why, "via": "console" })));
    hub_of(st).root_revoked(id);
    Ok(format!("revoked {id}: link cut, key refused, directory pushed"))
}

/* ------------------------------------------------------------------ POST /t/roots/rebind */

fn rebind_input(root_id: &str, old_secret: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(REBIND_CTX.len() + root_id.len() + old_secret.len() + 2);
    m.extend_from_slice(REBIND_CTX.as_bytes());
    m.push(0);
    m.extend_from_slice(root_id.as_bytes());
    m.push(0);
    m.extend_from_slice(old_secret.as_bytes());
    m
}

/// `POST /t/roots/rebind` — a v0.9-joined root binds its new Ed25519 key with its old root
/// secret, once. No cookie: the root proves itself (the old secret + the new key's signature
/// over it), the trunk burns the secret, and the next dial is the normal C4 handshake.
pub async fn rebind(st: &Arc<State>, inc: &mut super::server::Incoming) -> Resp {
    let body = match inc.body(16 * 1024).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        return Resp::json(400, &json!({ "error": "a JSON object" }));
    };
    let s = |k: &str| v[k].as_str().unwrap_or_default().trim().to_string();
    let root_id = s("root_id");
    if !crate::wg::valid_addr(&root_id) || root_id.len() > 60 {
        return Resp::json(400, &json!({ "error": "root_id: the v0.9 root id" }));
    }
    let old_secret = s("old_secret");
    let Some(root_pub) = proto::public_from_b64u(&s("root_pub")) else {
        return Resp::json(400, &json!({ "error": "root_pub: a b64url Ed25519 public key" }));
    };
    let Some(sig) = proto::unb64u(&s("sig")) else {
        return Resp::json(400, &json!({ "error": "sig: a b64url signature" }));
    };
    if old_secret.len() < 16 || old_secret.len() > 256 {
        return Resp::json(400, &json!({ "error": "old_secret: the v0.9 root secret" }));
    }
    // the new key must sign the old secret: a copied public key alone cannot take the id
    if !proto::verify(&root_pub, &rebind_input(&root_id, &old_secret), &sig) {
        return Resp::json(401, &json!({ "error": "bad signature (the new key signs \"ygg-trunk-v1/rebind\\0\" root_id \"\\0\" old_secret)" }));
    }
    let now = now_ms();
    let row: Option<(Option<String>, Option<String>, Option<i64>)> = st
        .db
        .with(|c| c.query_row("SELECT rebind_secret_hash, root_pub, revoked_at FROM roots WHERE id = ?1", [&root_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())
        .ok()
        .flatten();
    let Some((secret_hash, root_pub_now, revoked_at)) = row else {
        return Resp::json(404, &json!({ "error": "no such root" }));
    };
    if revoked_at.is_some() {
        return Resp::json(410, &json!({ "error": "this root was revoked" }));
    }
    let Some(hash) = secret_hash else {
        // already rebound (or never imported): the normal handshake is the way in
        return if root_pub_now.as_deref() == Some(proto::b64u(&root_pub).as_str()) {
            Resp::json(200, &json!({ "bound": root_id, "note": "already bound to this key" }))
        } else {
            Resp::json(410, &json!({ "error": "no rebind secret: this root is not waiting for one (enroll instead)" }))
        };
    };
    let got = crypto::sha256_hex(old_secret.as_bytes());
    if !proto::ct_eq(got.as_bytes(), hash.to_ascii_lowercase().as_bytes()) {
        super::idp::audit(&st, super::idp::audit::Entry::new("root.rebind.fail").target("root", &root_id).detail(json!({ "why": "old secret" })));
        return Resp::json(401, &json!({ "error": "wrong old secret" }));
    }
    // bind the new key and burn the secret, in one step
    let n = st
        .db
        .with(|c| c.execute("UPDATE roots SET root_pub = ?1, rebind_secret_hash = NULL, enrolled_by_device = 'rebind' WHERE id = ?2 AND rebind_secret_hash = ?3", params![proto::b64u(&root_pub), root_id, hash]))
        .unwrap_or(0);
    if n == 0 {
        return Resp::json(409, &json!({ "error": "rebind raced: the secret was just used" }));
    }
    super::idp::audit(&st, super::idp::audit::Entry::new("root.rebind").target("root", &root_id).detail(json!({ "root_pub": proto::b64u(&root_pub) })));
    hub_of(st).push_directory();
    Resp::json(200, &json!({ "bound": root_id, "trunk": { "url": st.cfg.origin(), "trunk_id": st.trunk_id, "trunk_key": hub_of(st).trunk_key_b64u() } }))
}

#[cfg(all(test, feature = "bridge"))]
mod tests;
