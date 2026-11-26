//! Roots on the v1 trunk (spec §5.6 F3/F4, §6 `roots`/`enrollments`, §7): the registry in
//! trunk.db, enrollment (desktop 1-tap card + headless rotating code), the device's view of its
//! roots (`/t/me/roots`, C6 shape), the door choice, rename and revoke.
//!
//! Rules carried from `branch/lib/roots.ts` (C3/C4 of §13): input cleaning, ids never reused, a
//! WireGuard key enrolled once (409), 5 enrollments per 10 min per client address, ≤ 32 pending.
//! New in v1: the poll result is sealed in the DB until collected, then delivered once (C6 fix);
//! a rotating 6-digit code (300 s, ≤ 15 s overlap) for the headless path, with 5 wrong codes
//! killing an enrollment and 10 wrong per account per hour locking code entry for 1 h.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, Weak};

use ring::hmac;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::crypto;
use super::db::now_ms;
use super::http::Resp;
use super::paseto::Claims;
use super::proto;
use super::relay::hub::{Authority, Registry, RootRec};
use super::server::{Incoming, State};
use super::state::{DenyEntry, Key};

pub mod pages;

/// The headless code's window and the overlap a just-rotated code keeps.
pub const CODE_PERIOD_MS: i64 = 300_000;
pub const CODE_OVERLAP_MS: i64 = 15_000;
/// How long an enrollment waits for its approval.
pub const ENROLL_TTL_MS: i64 = 30 * 60_000;
pub const ENROLL_PER_IP: usize = 5;
pub const ENROLL_WINDOW_MS: i64 = 10 * 60_000;
pub const MAX_PENDING: i64 = 32;
pub const WRONG_PER_ENROLLMENT: i64 = 5;
pub const WRONG_PER_ACCOUNT_HOUR: i64 = 10;
pub const CODE_LOCK_MS: i64 = 3_600_000;
/// step-up freshness (§4.1 item 3)
pub const FRESH_MS: i64 = 600_000;
/// how long a revoked device stays on the roots' deny-list (its last access token's life)
pub const DENY_FOR_MS: i64 = 16 * 60_000;

/* ------------------------------------------------------------------ the registry (trunk.db) */

const ROOT_COLS: &str = "id, name, root_pub, wg_pub, wg_addr, dtls_fp, has_app, has_voice, peer_token_hash, revoked_at";

fn root_row(r: &rusqlite::Row) -> rusqlite::Result<RootRec> {
    let pk: String = r.get(2)?;
    Ok(RootRec {
        id: r.get(0)?,
        name: r.get(1)?,
        root_pub: proto::public_from_b64u(&pk).unwrap_or([0; 32]),
        wg_pub: r.get(3)?,
        wg_addr: r.get(4)?,
        dtls_fp: r.get(5)?,
        has_app: r.get::<_, i64>(6)? != 0,
        has_voice: r.get::<_, i64>(7)? != 0,
        peer_token_sha256: r.get(8)?,
        revoked: r.get::<_, Option<i64>>(9)?.is_some(),
    })
}

/// The hub's view of trunk.db `roots`.
pub struct DbRegistry {
    pub st: Weak<State>,
    seen: Mutex<HashMap<String, u64>>,
}

impl DbRegistry {
    pub fn new(st: &Arc<State>) -> DbRegistry {
        DbRegistry { st: Arc::downgrade(st), seen: Mutex::default() }
    }
}

impl Registry for DbRegistry {
    fn root(&self, id: &str) -> Option<RootRec> {
        let st = self.st.upgrade()?;
        st.db
            .with(|c| c.query_row(&format!("SELECT {ROOT_COLS} FROM roots WHERE id = ?1"), [id], root_row).optional())
            .ok()
            .flatten()
    }

    fn roots(&self) -> Vec<RootRec> {
        let Some(st) = self.st.upgrade() else { return vec![] };
        st.db
            .with(|c| {
                let mut s = c.prepare(&format!("SELECT {ROOT_COLS} FROM roots WHERE revoked_at IS NULL ORDER BY enrolled_at, id"))?;
                let v = s.query_map([], root_row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .unwrap_or_default()
    }

    fn seen(&self, id: &str, now: u64) {
        {
            let mut s = self.seen.lock().unwrap();
            if s.get(id).is_some_and(|t| now < t + 30_000) {
                return;
            }
            s.insert(id.to_string(), now);
        }
        if let Some(st) = self.st.upgrade() {
            let _ = st.db.with(|c| c.execute("UPDATE roots SET last_seen = ?1 WHERE id = ?2", params![now as i64, id]));
        }
    }
}

/// What the roots learn of the identity side: the token keys, the kill switch, the deny-list
/// (every device revoked within the life of its last access token).
pub struct DbAuthority {
    pub st: Weak<State>,
}

impl Authority for DbAuthority {
    fn token_keys(&self) -> Vec<Key> {
        let Some(st) = self.st.upgrade() else { return vec![] };
        serde_json::from_value(st.keys_json()).unwrap_or_default()
    }

    fn kill(&self) -> (u64, bool) {
        match self.st.upgrade() {
            Some(st) => (st.kill_epoch(), st.lockdown()),
            None => (0, false),
        }
    }

    fn deny(&self) -> Vec<DenyEntry> {
        let Some(st) = self.st.upgrade() else { return vec![] };
        let since = now_ms() - DENY_FOR_MS;
        st.db
            .with(|c| {
                let mut s = c.prepare("SELECT id, revoked_at FROM devices WHERE revoked_at IS NOT NULL AND revoked_at > ?1")?;
                let v = s
                    .query_map([since], |r| Ok(DenyEntry { did: r.get(0)?, until: (r.get::<_, i64>(1)? + DENY_FOR_MS) as u64 }))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .unwrap_or_default()
    }
}

/* ------------------------------------------------------------------ helpers */

fn err(status: u16, msg: &str) -> Resp {
    Resp::json(status, &json!({ "error": msg }))
}

/// The C3 check for a `/t/*` call (401 with C3's words).
pub fn device(st: &State, inc: &Incoming) -> Result<Claims, Resp> {
    st.check_access(&inc.req, inc.ip).map_err(|w| Resp::json(401, &serde_json::from_str(&w.body()).unwrap_or_default()))
}

/// A browser write must come from the trunk's own origin (SameSite=Strict cookies + Origin).
pub fn same_origin(st: &State, inc: &Incoming) -> Result<(), Resp> {
    match inc.req.header("origin") {
        Some(o) if st.cfg.write_origins().iter().any(|w| w.eq_ignore_ascii_case(o.trim_end_matches('/'))) => Ok(()),
        _ => Err(err(403, "a write must come from this trunk's own pages (Origin)")),
    }
}

/// Admin only (§8 roles). The IDP owns this check (idp::session::Who); until it is merged here
/// the device row is read directly: role admin, not revoked.
pub fn admin(st: &State, who: &Claims) -> Result<(), Resp> {
    let row: Option<(String, Option<i64>)> = st
        .db
        .with(|c| c.query_row("SELECT role, revoked_at FROM devices WHERE id = ?1", [&who.did], |r| Ok((r.get(0)?, r.get(1)?))).optional())
        .ok()
        .flatten();
    match row {
        Some((role, None)) if role == "admin" && who.role == "admin" => Ok(()),
        Some((_, None)) => Err(err(403, "admin only")),
        _ => Err(Resp::json(401, &json!({ "why": "revoked", "reauth": "login" }))),
    }
}

/// Admin with a fresh step-up (2FA within 600 s on this device): root approval (§8). The IDP's
/// helper (`Who::fresh`) replaces this read at merge time.
pub fn admin_fresh(st: &State, who: &Claims) -> Result<(), Resp> {
    admin(st, who)?;
    let fresh_ms = if st.fast { 60_000 } else { FRESH_MS };
    let last: Option<i64> = st
        .db
        .with(|c| c.query_row("SELECT last_2fa_at FROM devices WHERE id = ?1", [&who.did], |r| r.get(0)).optional())
        .ok()
        .flatten()
        .flatten();
    if last.is_some_and(|t| t + fresh_ms > now_ms()) {
        Ok(())
    } else {
        Err(Resp::json(403, &json!({ "error": "confirm it's you first", "step_up": true })))
    }
}

/// An audit entry. The IDP owns the hash-chained log (idp::audit); WIRE's events go through this
/// one function so the merge is one line. Until then: the console.
pub fn audit(_st: &State, who: Option<&Claims>, action: &str, kind: &str, target: &str, detail: Value) {
    eprintln!("  trunk: audit {action} {kind} {target} by {} {detail}", who.map(|w| w.did.as_str()).unwrap_or("-"));
}

fn clean(s: &str, max: usize, ok: impl Fn(u8) -> bool) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.len() <= max && t.bytes().all(ok)).then(|| t.to_string())
}

fn hostname_ok(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_'
}

/// A root name: lowercased hostname-ish, 1–40 (the brain uses it as a peer name and a url segment).
pub fn clean_name(s: &str) -> Option<String> {
    let n: String = s.trim().to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let n = n.trim_matches('-').to_string();
    (!n.is_empty() && n.len() <= 40).then_some(n)
}

pub fn dtls_fp_ok(s: &str) -> bool {
    s.is_empty() || (s.len() <= 120 && s.starts_with("sha-256 ") && s[8..].bytes().all(|b| b.is_ascii_hexdigit() || b == b':'))
}

/// `start_region` vs a /24 or /48 for the audit (never a full address).
pub fn ip_trunc(ip: IpAddr) -> String {
    match super::config::canon(ip) {
        IpAddr::V4(v) => {
            let o = v.octets();
            format!("{}.{}.{}.0/24", o[0], o[1], o[2])
        }
        IpAddr::V6(v) => {
            let g = v.segments();
            format!("{:x}:{:x}:{:x}::/48", g[0], g[1], g[2])
        }
    }
}

/* ------------------------------------------------------------------ the rotating code */

fn code_at(seed: &[u8], counter: i64) -> String {
    let k = hmac::Key::new(hmac::HMAC_SHA256, seed);
    let t = hmac::sign(&k, &counter.to_be_bytes());
    let n = u32::from_be_bytes(t.as_ref()[..4].try_into().expect("4 bytes")) % 1_000_000;
    format!("{n:06}")
}

/// The code shown now and how long it has left (ms).
pub fn current_code(seed: &[u8], epoch: i64, now: i64) -> (String, i64) {
    let c = (now - epoch).max(0) / CODE_PERIOD_MS;
    (code_at(seed, c), CODE_PERIOD_MS - (now - epoch).max(0) % CODE_PERIOD_MS)
}

/// Only the latest code is valid, plus the previous one for ≤ 15 s after a rotation.
pub fn code_valid(seed: &[u8], epoch: i64, now: i64, got: &str) -> bool {
    let got = got.trim();
    if got.len() != 6 || !got.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let el = (now - epoch).max(0);
    let c = el / CODE_PERIOD_MS;
    let cur = proto::ct_eq(code_at(seed, c).as_bytes(), got.as_bytes());
    let prev = c > 0 && el % CODE_PERIOD_MS < CODE_OVERLAP_MS && proto::ct_eq(code_at(seed, c - 1).as_bytes(), got.as_bytes());
    cur | prev
}

/// Persisted lockout for code entry per account: 10 wrong per hour → locked 1 h.
fn code_locked(st: &State, acc: &str) -> Option<i64> {
    let key = format!("enroll.code:{acc}");
    let until: Option<Option<i64>> =
        st.db.with(|c| c.query_row("SELECT locked_until FROM limits WHERE key = ?1", [&key], |r| r.get(0)).optional()).ok().flatten();
    until.flatten().filter(|t| *t > now_ms())
}

/// Count a wrong code for the account; returns how many are left this hour (0 = now locked).
fn code_wrong(st: &State, acc: &str) -> i64 {
    let key = format!("enroll.code:{acc}");
    let now = now_ms();
    let n: i64 = st
        .db
        .with(|c| {
            let row: Option<(i64, i64)> = c.query_row("SELECT failures, updated_at FROM limits WHERE key = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let n = match row {
                Some((f, at)) if now - at < 3_600_000 => f + 1,
                _ => 1,
            };
            let start = match row {
                Some((_, at)) if now - at < 3_600_000 => at,
                _ => now,
            };
            let locked = (n >= WRONG_PER_ACCOUNT_HOUR).then_some(now + CODE_LOCK_MS);
            c.execute(
                "INSERT INTO limits (key, tokens, updated_at, failures, locked_until) VALUES (?1, 0, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET updated_at = ?2, failures = ?3, locked_until = COALESCE(?4, locked_until)",
                params![key, start, n, locked],
            )?;
            Ok(n)
        })
        .unwrap_or(WRONG_PER_ACCOUNT_HOUR);
    (WRONG_PER_ACCOUNT_HOUR - n).max(0)
}

/* ------------------------------------------------------------------ enrollment */

/// The trunk's WireGuard net, chosen once (`10.x.y.0/24`), and the next never-used address in it.
fn alloc_wg_addr(c: &rusqlite::Connection) -> rusqlite::Result<Option<String>> {
    let net: Option<String> = c.query_row("SELECT v FROM meta WHERE k = 'wg_net'", [], |r| r.get(0)).optional()?;
    let net = match net {
        Some(n) => n,
        None => {
            let n = format!("10.{}.{}.0/24", 16 + crypto::random_below(234), 1 + crypto::random_below(254));
            c.execute("INSERT INTO meta (k, v) VALUES ('wg_net', ?1)", [&n])?;
            n
        }
    };
    let base = net.split('/').next().unwrap_or("").rsplit_once('.').map(|(b, _)| b.to_string()).unwrap_or_default();
    let used: Vec<String> = {
        let mut s = c.prepare("SELECT wg_addr FROM roots")?;
        let v = s.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        v
    };
    Ok((1..=254).map(|i| format!("{base}.{i}")).find(|a| !used.contains(a)))
}

#[derive(Default)]
pub struct EnrollWindow {
    by_ip: Mutex<HashMap<IpAddr, Vec<i64>>>,
}

impl EnrollWindow {
    /// 5 per 10 minutes per client address (roots.ts `windowTake`).
    pub fn take(&self, ip: IpAddr, now: i64) -> bool {
        let mut m = self.by_ip.lock().unwrap();
        if m.len() > 10_000 {
            m.retain(|_, v| v.iter().any(|t| now - t < ENROLL_WINDOW_MS)); // no clear-all (§8 fix)
        }
        let v = m.entry(ip).or_default();
        v.retain(|t| now - t < ENROLL_WINDOW_MS);
        if v.len() >= ENROLL_PER_IP {
            return false;
        }
        v.push(now);
        true
    }
}

/// POST /t/roots/enroll (the installer; no cookies).
pub async fn enroll_start(st: &Arc<State>, inc: &mut Incoming) -> Resp {
    let now = now_ms();
    if !super::relay::relay(st).enroll.take(inc.ip, now) {
        return err(429, "too many enrollments from this address (5 per 10 minutes)");
    }
    let body = match inc.body(16 * 1024).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Ok(v) = serde_json::from_slice::<Value>(&body) else { return err(400, "a JSON object") };
    let s = |k: &str| v[k].as_str().unwrap_or("");
    let Some(hostname) = clean(s("hostname"), 64, hostname_ok) else { return err(400, "hostname: 1–64 of A-Z a-z 0-9 . _ -") };
    let Some(os) = clean(s("os"), 16, |b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') else { return err(400, "os") };
    let Some(arch) = clean(s("arch"), 16, |b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') else { return err(400, "arch") };
    let version = clean(s("version"), 64, |b| b.is_ascii_graphic()).unwrap_or_default();
    let build_id = clean(s("build_id"), 64, |b| b.is_ascii_alphanumeric() || b == b'-').unwrap_or_default();
    let name = clean_name(if s("name").is_empty() { &hostname } else { s("name") }).unwrap_or_else(|| "root".into());
    let Some(root_pub) = proto::public_from_b64u(s("root_pub")).map(|k| proto::b64u(&k)) else { return err(400, "root_pub: a b64url Ed25519 public key") };
    let Ok(wg_raw) = crate::wg::decode_key(s("wg_pub")) else { return err(400, "wg_pub: a base64 WireGuard public key") };
    let wg_pub = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wg_raw);
    let dtls_fp = s("dtls_fp").trim().to_string();
    if !dtls_fp_ok(&dtls_fp) {
        return err(400, "dtls_fp: \"sha-256 AB:CD:…\"");
    }
    let (has_app, has_voice) = (v["has_app"].as_bool().unwrap_or(false), v["has_voice"].as_bool().unwrap_or(false));
    let id = crypto::new_id("enr");
    let secret = crypto::secret("bfne-", 32);
    let seed = crypto::random_bytes::<32>();
    let sealed = st.kek.seal(&format!("enroll-code:{id}"), &seed);
    let region = inc.region();
    let r = st.db.with(|c| {
        let tx = c.transaction()?;
        // a key enrolled once is never taken again (409), revoked roots included
        let taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE wg_pub = ?1 OR root_pub = ?2)", params![wg_pub, root_pub], |r| r.get(0))?;
        if taken {
            return Ok(Err(409));
        }
        // the same machine asking again: its older pending enrollment ends
        tx.execute("UPDATE enrollments SET status = 'expired' WHERE status = 'pending' AND wg_pub = ?1 AND root_pub = ?2", params![wg_pub, root_pub])?;
        tx.execute("UPDATE enrollments SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?1", [now])?;
        let pending: i64 = tx.query_row("SELECT COUNT(*) FROM enrollments WHERE status = 'pending'", [], |r| r.get(0))?;
        if pending >= MAX_PENDING {
            return Ok(Err(429));
        }
        let other: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM enrollments WHERE status = 'pending' AND (wg_pub = ?1 OR root_pub = ?2))", params![wg_pub, root_pub], |r| r.get(0))?;
        if other {
            return Ok(Err(409));
        }
        tx.execute(
            "INSERT INTO enrollments (id, poll_secret_hash, code_seed_enc, code_epoch, start_region, start_ip_trunc, hostname, os, arch, version, build_id,
                                      has_app, has_voice, name, root_pub, wg_pub, dtls_fp, status, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 'pending', ?18, ?19)",
            params![id, proto::sha256_hex(secret.as_bytes()), sealed, now, region, ip_trunc(inc.ip), hostname, os, arch, version, build_id,
                    has_app as i64, has_voice as i64, name, root_pub, wg_pub, dtls_fp, now, now + ENROLL_TTL_MS],
        )?;
        tx.commit()?;
        Ok(Ok(()))
    });
    match r {
        Ok(Ok(())) => {}
        Ok(Err(409)) => return err(409, "this computer's keys are already enrolled (or waiting): a key is enrolled once"),
        Ok(Err(_)) => return err(429, "too many enrollments are waiting (32)"),
        Err(e) => return err(500, &e),
    }
    let (code, left) = current_code(&seed, now, now);
    audit(st, None, "root.enroll.start", "enrollment", &id, json!({ "hostname": hostname, "ip": ip_trunc(inc.ip) }));
    Resp::json(
        200,
        &json!({
            "id": id, "poll_secret": secret, "poll_every_s": 2,
            "approve_url": format!("{}/auth/root?e={id}", st.cfg.origin()),
            "code": code, "code_expires_in": left / 1000, "expires_in": ENROLL_TTL_MS / 1000,
            "wg_fp": crate::wg::fingerprint(&wg_raw),
        }),
    )
}

struct Enr {
    id: String,
    poll_secret_hash: String,
    seed: Vec<u8>,
    code_epoch: i64,
    attempts: i64,
    start_region: String,
    hostname: String,
    os: String,
    arch: String,
    version: String,
    build_id: String,
    has_app: bool,
    has_voice: bool,
    name: String,
    root_pub: String,
    wg_pub: String,
    dtls_fp: String,
    status: String,
    result_enc: Option<Vec<u8>>,
    root_id: Option<String>,
    created_at: i64,
    expires_at: i64,
}

fn load_enr(st: &State, id: &str) -> Option<Enr> {
    let row = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT id, poll_secret_hash, code_seed_enc, code_epoch, attempts, start_region, hostname, os, arch, version, build_id,
                        has_app, has_voice, name, root_pub, wg_pub, dtls_fp, status, result_enc, root_id, created_at, expires_at
                 FROM enrollments WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Vec<u8>>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        [r.get::<_, String>(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?],
                        (r.get::<_, i64>(11)? != 0, r.get::<_, i64>(12)? != 0),
                        [r.get::<_, String>(13)?, r.get(14)?, r.get(15)?, r.get(16)?, r.get(17)?],
                        (r.get::<_, Option<Vec<u8>>>(18)?, r.get::<_, Option<String>>(19)?, r.get::<_, i64>(20)?, r.get::<_, i64>(21)?),
                    ))
                },
            )
            .optional()
        })
        .ok()
        .flatten()?;
    let (id, psh, sealed, code_epoch, attempts, a, (has_app, has_voice), b, (result_enc, root_id, created_at, expires_at)) = row;
    let seed = st.kek.open(&format!("enroll-code:{id}"), &sealed).ok()?;
    let [start_region, hostname, os, arch, version, build_id] = a;
    let [name, root_pub, wg_pub, dtls_fp, status] = b;
    let status = if status == "pending" && expires_at <= now_ms() { "expired".to_string() } else { status };
    Some(Enr {
        id, poll_secret_hash: psh, seed, code_epoch, attempts, start_region, hostname, os, arch, version, build_id, has_app, has_voice,
        name, root_pub, wg_pub, dtls_fp, status, result_enc, root_id, created_at, expires_at,
    })
}

fn set_status(st: &State, id: &str, status: &str) {
    let _ = st.db.with(|c| c.execute("UPDATE enrollments SET status = ?1 WHERE id = ?2", params![status, id]));
}

/// POST /t/roots/enroll/:id/poll `{secret}` — every 2 s; the result once.
pub async fn enroll_poll(st: &Arc<State>, inc: &mut Incoming, id: &str) -> Resp {
    let body = match inc.body(4096).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let secret = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["secret"].as_str().map(str::to_string)).unwrap_or_default();
    let Some(e) = load_enr(st, id) else { return err(404, "no such enrollment") };
    if secret.is_empty() || !proto::ct_eq(proto::sha256_hex(secret.as_bytes()).as_bytes(), e.poll_secret_hash.as_bytes()) {
        return err(404, "no such enrollment");
    }
    let now = now_ms();
    match e.status.as_str() {
        "pending" => {
            let (code, left) = current_code(&e.seed, e.code_epoch, now);
            Resp::json(200, &json!({ "status": "pending", "code": code, "code_expires_in": left / 1000, "expires_in": (e.expires_at - now) / 1000 }))
        }
        "approved" => {
            // delivered once: the sealed result leaves the DB with this answer
            let taken = st
                .db
                .with(|c| c.execute("UPDATE enrollments SET status = 'delivered', result_enc = NULL WHERE id = ?1 AND status = 'approved'", [id]))
                .unwrap_or(0);
            let opened = e.result_enc.as_deref().and_then(|b| st.kek.open(&format!("enroll-result:{id}"), b).ok());
            match (taken, opened) {
                (1, Some(plain)) => {
                    audit(st, None, "root.enroll.collected", "root", e.root_id.as_deref().unwrap_or(""), json!({}));
                    Resp::new(200, "application/json", plain)
                }
                _ => Resp::json(410, &json!({ "status": "delivered" })),
            }
        }
        "delivered" => Resp::json(410, &json!({ "status": "delivered" })),
        other => Resp::json(200, &json!({ "status": other })),
    }
}

fn card(st: &State, e: &Enr, region: &str) -> Value {
    let wg_fp = crate::wg::decode_key(&e.wg_pub).map(|k| crate::wg::fingerprint(&k)).unwrap_or_default();
    let now = now_ms();
    json!({
        "id": e.id, "hostname": e.hostname, "name": e.name, "os": e.os, "arch": e.arch, "version": e.version, "build_id": e.build_id,
        "has_app": e.has_app, "has_voice": e.has_voice, "wg_fp": wg_fp, "root_fp": proto::kid_of(&proto::public_from_b64u(&e.root_pub).unwrap_or([0; 32])),
        "dtls_fp": e.dtls_fp, "status": e.status, "created_at": e.created_at, "expires_in": ((e.expires_at - now) / 1000).max(0),
        "region_mismatch": e.start_region != region, "needs_code": e.start_region != region,
        "trunk": st.cfg.origin(),
    })
}

/// GET /t/roots/enroll/:id — the desktop card (an admin device).
pub fn enroll_card(st: &State, inc: &Incoming, who: &Claims, id: &str) -> Resp {
    if let Err(r) = admin(st, who) {
        return r;
    }
    match load_enr(st, id) {
        Some(e) => Resp::json(200, &card(st, &e, &inc.region())),
        None => err(404, "no such enrollment"),
    }
}

/// POST /t/roots/enroll/:id/approve `{code?, name?}` — admin, fresh. A region mismatch between the
/// installer and this browser also asks for the terminal code (anti drive-by, F3).
pub async fn enroll_approve(st: &Arc<State>, inc: &mut Incoming, who: &Claims, id: &str) -> Resp {
    if let Err(r) = admin_fresh(st, who) {
        return r;
    }
    let body = inc.body(4096).await.unwrap_or_default();
    let v: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let Some(e) = load_enr(st, id) else { return err(404, "no such enrollment") };
    if e.status != "pending" {
        return Resp::json(409, &json!({ "error": "this enrollment is no longer waiting", "status": e.status }));
    }
    let now = now_ms();
    let code = v["code"].as_str().unwrap_or("");
    if e.start_region != inc.region() || !code.is_empty() {
        if let Some(t) = code_locked(st, &who.sub) {
            return Resp::json(429, &json!({ "error": "code entry is locked for an hour", "retry_in": (t - now) / 1000 }));
        }
        if !code_valid(&e.seed, e.code_epoch, now, code) {
            let attempts = e.attempts + 1;
            let _ = st.db.with(|c| c.execute("UPDATE enrollments SET attempts = ?1 WHERE id = ?2", params![attempts, id]));
            let left_acc = code_wrong(st, &who.sub);
            if attempts >= WRONG_PER_ENROLLMENT {
                set_status(st, id, "expired");
                audit(st, Some(who), "root.enroll.killed", "enrollment", id, json!({ "why": "5 wrong codes" }));
                return Resp::json(410, &json!({ "error": "5 wrong codes: this enrollment is over (start it again on the computer)" }));
            }
            audit(st, Some(who), "root.enroll.code_wrong", "enrollment", id, json!({ "attempts": attempts }));
            return Resp::json(403, &json!({ "error": "wrong code", "left": (WRONG_PER_ENROLLMENT - attempts).min(left_acc) }));
        }
    }
    let name = v["name"].as_str().and_then(clean_name).unwrap_or(e.name.clone());
    let root_id = crypto::new_id("rt");
    let peer_token = crypto::secret("ygp-", 32);
    let r = st.db.with(|c| {
        let tx = c.transaction()?;
        let still: bool = tx.query_row("SELECT status = 'pending' FROM enrollments WHERE id = ?1", [id], |r| r.get(0))?;
        if !still {
            return Ok(Err("this enrollment is no longer waiting"));
        }
        let Some(addr) = alloc_wg_addr(&tx)? else { return Ok(Err("the trunk's tunnel range is full (254 roots)")) };
        let taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE wg_pub = ?1 OR root_pub = ?2)", params![e.wg_pub, e.root_pub], |r| r.get(0))?;
        if taken {
            return Ok(Err("this computer's keys are already enrolled"));
        }
        tx.execute(
            "INSERT INTO roots (id, name, hostname, os, arch, version, build_id, has_app, has_voice, root_pub, wg_pub, wg_addr, dtls_fp,
                                peer_token_hash, enrolled_by_device, enrolled_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![root_id, name, e.hostname, e.os, e.arch, e.version, e.build_id, e.has_app as i64, e.has_voice as i64, e.root_pub, e.wg_pub,
                    addr, e.dtls_fp, proto::sha256_hex(peer_token.as_bytes()), who.did, now],
        )?;
        let net: String = tx.query_row("SELECT v FROM meta WHERE k = 'wg_net'", [], |r| r.get(0))?;
        tx.execute("UPDATE enrollments SET status = 'approved', approved_by_device = ?1, root_id = ?2 WHERE id = ?3", params![who.did, root_id, id])?;
        tx.commit()?;
        Ok(Ok((addr, net)))
    });
    let (addr, net) = match r {
        Ok(Ok(x)) => x,
        Ok(Err(m)) => return err(409, m),
        Err(e) => return err(500, &e),
    };
    let hub = super::relay::hub(st);
    hub.push_directory();
    let result = json!({
        "status": "approved", "root_id": root_id, "name": name, "wg_addr": addr, "wg_net": net,
        "trunk": { "url": st.cfg.origin(), "trunk_id": st.trunk_id, "trunk_key": hub.trunk_key_b64u() },
        "peer_token": peer_token, "directory": hub.directory(),
    });
    let sealed = st.kek.seal(&format!("enroll-result:{id}"), result.to_string().as_bytes());
    let _ = st.db.with(|c| c.execute("UPDATE enrollments SET result_enc = ?1 WHERE id = ?2", params![sealed, id]));
    audit(st, Some(who), "root.enroll.approve", "root", &root_id, json!({ "enrollment": id, "name": name, "region": inc.region() }));
    println!("  trunk: root {root_id} ({name}, {}) APPROVED by {}", e.hostname, who.did);
    Resp::json(200, &json!({ "root_id": root_id, "name": name, "wg_addr": addr }))
}

/// POST /t/roots/enroll/:id/refuse — admin.
pub fn enroll_refuse(st: &State, who: &Claims, id: &str) -> Resp {
    if let Err(r) = admin(st, who) {
        return r;
    }
    let n = st.db.with(|c| c.execute("UPDATE enrollments SET status = 'refused' WHERE id = ?1 AND status = 'pending'", [id])).unwrap_or(0);
    if n == 0 {
        return err(409, "this enrollment is no longer waiting");
    }
    audit(st, Some(who), "root.enroll.refuse", "enrollment", id, json!({}));
    Resp::json(200, &json!({ "refused": id }))
}

/// POST /t/roots/enroll/by-code `{code}` — admin: the headless path's card, found by its code.
pub async fn enroll_by_code(st: &Arc<State>, inc: &mut Incoming, who: &Claims) -> Resp {
    if let Err(r) = admin(st, who) {
        return r;
    }
    let now = now_ms();
    if let Some(t) = code_locked(st, &who.sub) {
        return Resp::json(429, &json!({ "error": "code entry is locked for an hour", "retry_in": (t - now) / 1000 }));
    }
    let body = inc.body(4096).await.unwrap_or_default();
    let code = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["code"].as_str().map(str::to_string)).unwrap_or_default();
    let ids: Vec<String> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT id FROM enrollments WHERE status = 'pending' AND expires_at > ?1")?;
            let v = s.query_map([now], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    for id in ids {
        if let Some(e) = load_enr(st, &id) {
            if code_valid(&e.seed, e.code_epoch, now, &code) {
                let mut c = card(st, &e, &inc.region());
                c["code_ok"] = json!(true);
                return Resp::json(200, &c);
            }
        }
    }
    let left = code_wrong(st, &who.sub);
    audit(st, Some(who), "root.enroll.code_wrong", "account", &who.sub, json!({ "left": left }));
    if left == 0 {
        return Resp::json(429, &json!({ "error": "10 wrong codes this hour: code entry is locked for an hour" }));
    }
    Resp::json(404, &json!({ "error": "no computer is waiting with that code", "left": left }))
}

/* ------------------------------------------------------------------ the device's roots */

fn door_of(st: &State, did: &str) -> Option<String> {
    st.db.with(|c| c.query_row("SELECT door_root FROM devices WHERE id = ?1", [did], |r| r.get::<_, Option<String>>(0)).optional()).ok().flatten().flatten()
}

/// The door a device's requests go to now (its choice when online with the app, else the first).
pub fn door_for(st: &Arc<State>, did: &str) -> Option<String> {
    super::relay::hub(st).door_for(door_of(st, did).as_deref())
}

/// GET /t/me/roots — C6: `[{id,name,online,has_app,has_voice,dtls_fp,door}]` (the pin source).
pub fn me_roots(st: &Arc<State>, who: &Claims) -> Resp {
    let hub = super::relay::hub(st);
    let door = door_for(st, &who.did);
    let now = now_ms();
    let list: Vec<Value> = hub
        .registry()
        .roots()
        .into_iter()
        .map(|r| {
            let _ = st.db.with(|c| {
                c.execute("INSERT OR IGNORE INTO pins_seen (device_id, root_id, dtls_fp, first_seen) VALUES (?1, ?2, ?3, ?4)", params![who.did, r.id, r.dtls_fp, now])
            });
            json!({ "id": r.id, "name": r.name, "online": hub.online(&r.id), "has_app": r.has_app, "has_voice": r.has_voice,
                    "dtls_fp": r.dtls_fp, "door": door.as_deref() == Some(r.id.as_str()) })
        })
        .collect();
    Resp::json(200, &Value::Array(list))
}

/// PUT /t/me/door `{root_id}` — this device's door (a root that runs the app).
pub async fn me_door(st: &Arc<State>, inc: &mut Incoming, who: &Claims) -> Resp {
    let body = inc.body(4096).await.unwrap_or_default();
    let id = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["root_id"].as_str().map(str::to_string)).unwrap_or_default();
    let Some(r) = super::relay::hub(st).registry().root(&id).filter(|r| !r.revoked) else { return err(404, "no such root") };
    if !r.has_app {
        return err(400, "that root runs no app: it cannot be a door");
    }
    let _ = st.db.with(|c| c.execute("UPDATE devices SET door_root = ?1 WHERE id = ?2", params![id, who.did]));
    Resp::json(200, &json!({ "door": id, "online": super::relay::hub(st).online(&id) }))
}

/// GET /t/roots — every root of this trunk (any device).
pub fn roots_list(st: &Arc<State>, who: &Claims) -> Resp {
    let hub = super::relay::hub(st);
    let door = door_for(st, &who.did);
    let rows: Vec<Value> = st
        .db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT id, name, hostname, os, arch, version, build_id, has_app, has_voice, wg_addr, dtls_fp, enrolled_at, last_seen
                 FROM roots WHERE revoked_at IS NULL ORDER BY enrolled_at, id",
            )?;
            let v = s
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "hostname": r.get::<_, String>(2)?,
                        "os": r.get::<_, String>(3)?, "arch": r.get::<_, String>(4)?, "version": r.get::<_, String>(5)?,
                        "build_id": r.get::<_, String>(6)?, "has_app": r.get::<_, i64>(7)? != 0, "has_voice": r.get::<_, i64>(8)? != 0,
                        "wg_addr": r.get::<_, String>(9)?, "dtls_fp": r.get::<_, String>(10)?, "enrolled_at": r.get::<_, i64>(11)?,
                        "last_seen": r.get::<_, Option<i64>>(12)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    let rows = rows
        .into_iter()
        .map(|mut r| {
            let id = r["id"].as_str().unwrap_or_default().to_string();
            r["online"] = json!(hub.online(&id));
            r["since"] = json!(hub.link_info(&id).map(|l| l.0));
            r["door"] = json!(door.as_deref() == Some(id.as_str()));
            r
        })
        .collect();
    Resp::json(200, &Value::Array(rows))
}

/// GET /t/roots/pending — the "wants to join" cards (any device reads; only an admin approves).
pub fn roots_pending(st: &Arc<State>, inc: &Incoming) -> Resp {
    let now = now_ms();
    let ids: Vec<String> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT id FROM enrollments WHERE status = 'pending' AND expires_at > ?1 ORDER BY created_at")?;
            let v = s.query_map([now], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    let region = inc.region();
    let cards: Vec<Value> = ids.iter().filter_map(|id| load_enr(st, id)).map(|e| card(st, &e, &region)).collect();
    Resp::json(200, &Value::Array(cards))
}

/// PATCH /t/roots/:id `{name}` — admin.
pub async fn root_patch(st: &Arc<State>, inc: &mut Incoming, who: &Claims, id: &str) -> Resp {
    if let Err(r) = admin(st, who) {
        return r;
    }
    let body = inc.body(4096).await.unwrap_or_default();
    let Some(name) = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["name"].as_str().and_then(clean_name)) else {
        return err(400, "name: 1–40 of a-z 0-9 -");
    };
    let n = st.db.with(|c| c.execute("UPDATE roots SET name = ?1 WHERE id = ?2 AND revoked_at IS NULL", params![name, id])).unwrap_or(0);
    if n == 0 {
        return err(404, "no such root");
    }
    audit(st, Some(who), "root.rename", "root", id, json!({ "name": name }));
    super::relay::hub(st).push_directory();
    Resp::json(200, &json!({ "id": id, "name": name }))
}

/// DELETE /t/roots/:id — admin: the root is revoked for good (P13 cut, its id never reused).
pub fn root_revoke(st: &Arc<State>, who: &Claims, id: &str, why: &str) -> Resp {
    if let Err(r) = admin(st, who) {
        return r;
    }
    let n = st
        .db
        .with(|c| c.execute("UPDATE roots SET revoked_at = ?1, revoked_by = ?2, revoked_why = ?3 WHERE id = ?4 AND revoked_at IS NULL", params![now_ms(), who.did, why, id]))
        .unwrap_or(0);
    if n == 0 {
        return err(404, "no such root");
    }
    let _ = st.db.with(|c| c.execute("UPDATE devices SET door_root = NULL WHERE door_root = ?1", [id]));
    audit(st, Some(who), "root.revoke", "root", id, json!({ "why": why }));
    super::relay::hub(st).root_revoked(id);
    Resp::json(200, &json!({ "revoked": id }))
}

#[cfg(all(test, feature = "bridge"))]
mod tests;

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn rotating_code_window_and_overlap() {
        let seed = [7u8; 32];
        let e = 1_000_000;
        let (c0, left) = current_code(&seed, e, e);
        assert_eq!((c0.len(), left), (6, CODE_PERIOD_MS));
        assert!(code_valid(&seed, e, e + 299_999, &c0));
        let (c1, _) = current_code(&seed, e, e + CODE_PERIOD_MS);
        assert_ne!(c0, c1);
        // the previous code keeps ≤ 15 s after the rotation, then only the latest is valid
        assert!(code_valid(&seed, e, e + CODE_PERIOD_MS + 14_999, &c0));
        assert!(!code_valid(&seed, e, e + CODE_PERIOD_MS + 15_000, &c0));
        assert!(code_valid(&seed, e, e + CODE_PERIOD_MS + 15_000, &c1));
        assert!(!code_valid(&seed, e, e, "12345"));
        assert!(!code_valid(&seed, e, e, "abcdef"));
        assert!(!code_valid(&[8u8; 32], e, e, &c0) || code_at(&[8u8; 32], 0) == c0);
    }

    #[test]
    fn names_and_window() {
        assert_eq!(clean_name("Mac-Studio.local").as_deref(), Some("mac-studio-local"));
        assert_eq!(clean_name("  "), None);
        assert_eq!(clean_name(&"x".repeat(41)), None);
        assert!(dtls_fp_ok("sha-256 AB:CD:01"));
        assert!(!dtls_fp_ok("md5 AB"));
        let w = EnrollWindow::default();
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        for _ in 0..ENROLL_PER_IP {
            assert!(w.take(ip, 0));
        }
        assert!(!w.take(ip, 1), "5 per 10 minutes per address");
        assert!(w.take("203.0.113.10".parse().unwrap(), 1), "another address");
        assert!(w.take(ip, ENROLL_WINDOW_MS + 1), "the window moves");
        assert_eq!(ip_trunc("203.0.113.9".parse().unwrap()), "203.0.113.0/24");
    }
}
