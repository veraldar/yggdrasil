//! The one admin account (spec §4.1 item 2, §5.6 F1–F2, §7): signup (claim ticket only), TOTP
//! enrolment, 10 single-use recovery codes, sign-in (password → second factor), step-up, and
//! the 2FA management behind `/t/account`.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::audit::Entry;
use super::limits::{self, Kind};
use super::session::{self, Who};
use super::{claim, passkey, password, qr, totp, MfaTicket};
use crate::v1::crypto::{random_below, random_bytes, sha256_hex, b64u};
use crate::v1::db::now_ms;
use crate::v1::http::Resp;
use crate::v1::server::State;

pub const RECOVERY_CODES: usize = 10;
const ALPHA: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

pub fn norm_email(e: &str) -> Option<String> {
    let e = e.trim().to_lowercase();
    let (local, domain) = e.split_once('@')?;
    let ok = !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(e)
}

fn generic_fail() -> Resp {
    Resp::json(401, &json!({ "error": "email or password is not right", "why": "credentials" }))
}

fn too_many(s: i64) -> Resp {
    Resp::json(429, &json!({ "error": "too many attempts — wait and try again", "why": "locked", "retry_after": s })).header("Retry-After", &s.to_string())
}

fn issuer(st: &State) -> String {
    st.cfg.host()
}

fn totp_view(st: &State, email: &str, seed: &[u8]) -> Value {
    let uri = totp::uri(&issuer(st), email, seed);
    json!({ "totp_uri": uri, "qr_svg": qr::svg(&uri), "secret": totp::b32(seed) })
}

/// Recovery code: 8 characters (40 bits) from an alphabet without 0/O/1/I, shown as `XXXX-XXXX`.
fn new_code() -> String {
    let s: String = (0..8).map(|_| ALPHA[random_below(32) as usize] as char).collect();
    format!("{}-{}", &s[..4], &s[4..])
}

fn code_norm(c: &str) -> String {
    c.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn code_hash(st: &State, account: &str, code: &str) -> String {
    st.kek.pepper("recovery", format!("{account}:{}", code_norm(code)).as_bytes())
}

/// 10 fresh codes (the old ones die); returned once, stored peppered.
pub fn new_recovery(st: &State, account: &str) -> Result<Vec<String>, String> {
    let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| new_code()).collect();
    let hashes: Vec<String> = codes.iter().map(|c| code_hash(st, account, c)).collect();
    st.db.with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM recovery_codes WHERE account_id = ?1", [account])?;
        for h in &hashes {
            tx.execute("INSERT INTO recovery_codes (account_id, code_hash) VALUES (?1, ?2)", params![account, h])?;
        }
        tx.commit()
    })?;
    Ok(codes)
}

pub fn recovery_left(st: &State, account: &str) -> i64 {
    st.db
        .with(|c| c.query_row("SELECT count(*) FROM recovery_codes WHERE account_id = ?1 AND used_at IS NULL", [account], |r| r.get(0)))
        .unwrap_or(0)
}

/// (seed, last_step, enrolled_at)
fn totp_row(st: &State, account: &str) -> Option<(Vec<u8>, i64, Option<i64>)> {
    let row: Option<(Vec<u8>, i64, Option<i64>)> = st
        .db
        .with(|c| c.query_row("SELECT secret_enc, last_step, enrolled_at FROM totp WHERE account_id = ?1", [account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())
        .ok()
        .flatten();
    let (blob, last, enrolled) = row?;
    let seed = st.kek.open(&format!("totp:{account}"), &blob).ok()?;
    Some((seed, last, enrolled))
}

fn store_totp(st: &State, account: &str, seed: &[u8], enrolled: Option<i64>, last_step: i64) -> Result<(), String> {
    let blob = st.kek.seal(&format!("totp:{account}"), seed);
    st.db.with(|c| {
        c.execute(
            "INSERT INTO totp (account_id, secret_enc, enrolled_at, last_step) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id) DO UPDATE SET secret_enc = ?2, enrolled_at = ?3, last_step = ?4",
            params![account, blob, enrolled, last_step],
        )
        .map(|_| ())
    })
}

/// Use a TOTP step once: only moves `last_step` forward (two racing requests: one wins).
fn take_step(st: &State, account: &str, step: i64) -> bool {
    st.db
        .with(|c| c.execute("UPDATE totp SET last_step = ?1 WHERE account_id = ?2 AND last_step < ?1", params![step, account]))
        .unwrap_or(0)
        == 1
}

fn take_recovery(st: &State, account: &str, code: &str) -> bool {
    let h = code_hash(st, account, code);
    st.db
        .with(|c| c.execute("UPDATE recovery_codes SET used_at = ?1 WHERE account_id = ?2 AND code_hash = ?3 AND used_at IS NULL", params![now_ms(), account, h]))
        .unwrap_or(0)
        == 1
}

/// The second factor for `account`: a TOTP code (each step once) or an unused recovery code.
/// Counts failures (5 → 15 min) and the network's (20/h → 429). Ok = "totp" | "recovery".
pub fn second_factor(st: &State, account: &str, totp_code: Option<&str>, recovery: Option<&str>, ip: IpAddr, what: &str) -> Result<&'static str, Resp> {
    let now = now_ms();
    let mk = limits::mfa_key(account);
    let nk = limits::net_key(ip);
    if let Some(s) = limits::locked(&st.db, &mk, now).or_else(|| limits::locked(&st.db, &nk, now)) {
        return Err(too_many(s));
    }
    let ok = match (totp_code.filter(|c| !c.trim().is_empty()), recovery.filter(|c| !c.trim().is_empty())) {
        (Some(code), _) => match totp_row(st, account) {
            Some((seed, last, Some(_))) => totp::verify(&seed, code, now / 1000, last).is_some_and(|s| take_step(st, account, s)).then_some("totp"),
            _ => None,
        },
        (None, Some(code)) => take_recovery(st, account, code).then_some("recovery"),
        _ => None,
    };
    match ok {
        Some(kind) => {
            limits::clear(&st.db, &mk);
            Ok(kind)
        }
        None => {
            let lock = limits::fail(&st.db, &mk, Kind::Mfa, &st.idp.t, now);
            let nlock = limits::fail(&st.db, &nk, Kind::Net, &st.idp.t, now);
            super::audit(st, Entry::new(&format!("{what}.mfa_fail")).account(account).ip(ip));
            if let Some(s) = lock {
                super::audit(st, Entry::new("lockout.mfa").account(account).ip(ip).detail(json!({ "seconds": s })));
                return Err(too_many(s));
            }
            if let Some(s) = nlock {
                super::audit(st, Entry::new("lockout.net").ip(ip).detail(json!({ "seconds": s })));
                return Err(too_many(s));
            }
            Err(Resp::json(401, &json!({ "error": "that code is not right", "why": "code" })))
        }
    }
}

fn account_by_email(st: &State, email: &str) -> Option<(String, Option<String>, String)> {
    st.db
        .with(|c| c.query_row("SELECT id, pw_hash, status FROM accounts WHERE email = ?1", [email], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())
        .ok()
        .flatten()
}

// ---- F1: signup and TOTP confirm (claim ticket only) ----------------------------------------

/// Before the claim completes, an account that never reached its TOTP confirm is replaced. Checked
/// inside the caller's transaction: once a TOTP is confirmed (the claim is completing) or the trunk
/// is claimed, nothing is replaced → Ok(false).
fn clear_unclaimed(tx: &rusqlite::Transaction) -> rusqlite::Result<bool> {
    let done: i64 = tx.query_row(
        "SELECT (SELECT count(*) FROM meta WHERE k = 'claimed_at') + (SELECT count(*) FROM totp WHERE enrolled_at IS NOT NULL)",
        [],
        |r| r.get(0),
    )?;
    if done > 0 {
        return Ok(false);
    }
    tx.execute("DELETE FROM totp", [])?;
    tx.execute("DELETE FROM recovery_codes", [])?;
    tx.execute("DELETE FROM oauth_ids", [])?;
    tx.execute("DELETE FROM passkeys", [])?;
    tx.execute("DELETE FROM accounts", [])?;
    Ok(true)
}

/// The OAuth claim (oauth::claim_with): the admin account bound to (issuer, subject), its e-mail
/// from the provider, no password; a TOTP enrolment is left pending (`/t/claim/totp`).
pub fn create_oauth_admin(st: &State, email: &str, issuer: &str, subject: &str) -> Result<String, String> {
    if st.claimed() {
        return Err("already claimed".into());
    }
    let id = crate::v1::crypto::new_id("acc");
    let now = now_ms();
    let made = st.db.with(|c| {
        let tx = c.transaction()?;
        if !clear_unclaimed(&tx)? {
            return Ok(false);
        }
        tx.execute("INSERT INTO accounts (id, email, pw_hash, role, status, created_at) VALUES (?1, ?2, NULL, 'admin', 'active', ?3)", params![id, email, now])?;
        tx.execute("INSERT INTO oauth_ids (account_id, issuer, subject, email, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![id, issuer, subject, email, now])?;
        tx.commit()?;
        Ok(true)
    })?;
    if !made {
        return Err("already claimed".into());
    }
    store_totp(st, &id, &random_bytes::<20>(), None, 0)?;
    Ok(id)
}

/// POST /t/claim/totp {ticket} → the pending authenticator of an OAuth claim (QR + key), for the
/// claim page to show after the provider sent the browser back.
pub fn claim_totp_view(st: &State, ticket: &str) -> Resp {
    match claim::check_ticket(st, ticket) {
        Ok(s) if s == "approved" => {}
        Ok(_) => return Resp::json(409, &json!({ "error": "approve the claim first", "why": "state" })),
        Err(e) => return e.resp(),
    }
    let acc: Option<(String, Option<String>)> = st.db.with(|c| c.query_row("SELECT id, email FROM accounts LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()).ok().flatten();
    let Some((account, email)) = acc else { return Resp::json(409, &json!({ "error": "create the account first", "why": "state" })) };
    match totp_row(st, &account) {
        Some((seed, _, None)) => Resp::json(200, &totp_view(st, email.as_deref().unwrap_or(""), &seed)),
        _ => Resp::json(409, &json!({ "error": "no authenticator is waiting to be confirmed", "why": "state" })),
    }
}

/// How the claim's account was made: "password" | "oauth:<provider>" (None = no account yet).
pub fn pending_via(st: &State) -> Option<String> {
    let row: Option<(String, Option<String>)> = st.db.with(|c| c.query_row("SELECT id, pw_hash FROM accounts LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()).ok().flatten();
    let (id, pw) = row?;
    if pw.is_some() {
        return Some("password".into());
    }
    let iss: Option<String> = st.db.with(|c| c.query_row("SELECT issuer FROM oauth_ids WHERE account_id = ?1", [&id], |r| r.get(0)).optional()).ok().flatten();
    let provider = iss.and_then(|i| st.cfg.oauth.iter().find(|(k, p)| p.issuer_of(k) == i).map(|(k, _)| k.clone()));
    Some(format!("oauth:{}", provider.unwrap_or_default()))
}

/// POST /t/auth/signup {ticket, email, password} → {totp_uri, qr_svg, secret}
pub async fn signup(st: &State, ticket: &str, email: &str, pw: &str, ip: IpAddr) -> Resp {
    if st.claimed() {
        return Resp::json(403, &json!({ "error": "this trunk is claimed — nobody else can register", "why": "claimed" }));
    }
    match claim::check_ticket(st, ticket) {
        Ok(s) if s == "approved" => {}
        Ok(_) => return Resp::json(409, &json!({ "error": "approve the claim first", "why": "state" })),
        Err(e) => return e.resp(),
    }
    let Some(email) = norm_email(email) else {
        return Resp::json(400, &json!({ "error": "that is not an email address", "why": "email" }));
    };
    if let Err(why) = password::policy(pw, &email) {
        return Resp::json(400, &json!({ "error": why, "why": "password" }));
    }
    let hash = st.idp.hasher.hash(pw).await;
    let id = crate::v1::crypto::new_id("acc");
    let seed = random_bytes::<20>();
    let made = st.db.with(|c| {
        let tx = c.transaction()?;
        // a signup that never reached TOTP confirm is replaced (the owner started again)
        if !clear_unclaimed(&tx)? {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO accounts (id, email, pw_hash, role, status, created_at) VALUES (?1, ?2, ?3, 'admin', 'active', ?4)",
            params![id, email, hash, now_ms()],
        )?;
        tx.commit()?;
        Ok(true)
    });
    match made {
        Ok(true) => {}
        Ok(false) => return Resp::json(403, &json!({ "error": "this trunk is claimed — nobody else can register", "why": "claimed" })),
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    }
    if let Err(e) = store_totp(st, &id, &seed, None, 0) {
        return Resp::json(500, &json!({ "error": e }));
    }
    super::audit(st, Entry::new("account.create").account(&id).ip(ip).target("account", &id).detail(json!({ "role": "admin", "via": "claim" })));
    Resp::json(200, &totp_view(st, &email, &seed))
}

/// POST /t/auth/totp/confirm {ticket, code} → {recovery_codes[10]} + cookies; the claim completes.
pub fn claim_totp_confirm(st: &State, ticket: &str, code: &str, ip: IpAddr, ua: &str) -> Resp {
    match claim::check_ticket(st, ticket) {
        Ok(s) if s == "approved" => {}
        Ok(_) => return Resp::json(409, &json!({ "error": "approve the claim first", "why": "state" })),
        Err(e) => return e.resp(),
    }
    let acc: Option<String> = st.db.with(|c| c.query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0)).optional()).ok().flatten();
    let Some(account) = acc else { return Resp::json(409, &json!({ "error": "create the account first", "why": "state" })) };
    let now = now_ms();
    let Some((seed, _, None)) = totp_row(st, &account) else {
        return Resp::json(409, &json!({ "error": "no authenticator is waiting to be confirmed", "why": "state" }));
    };
    let mk = limits::mfa_key(&account);
    if let Some(s) = limits::locked(&st.db, &mk, now).or_else(|| limits::locked(&st.db, &limits::net_key(ip), now)) {
        return too_many(s);
    }
    let Some(step) = totp::verify(&seed, code, now / 1000, 0) else {
        let lock = limits::fail(&st.db, &mk, Kind::Mfa, &st.idp.t, now);
        limits::fail(&st.db, &limits::net_key(ip), Kind::Net, &st.idp.t, now);
        super::audit(st, Entry::new("totp.confirm_fail").account(&account).ip(ip));
        return match lock {
            Some(s) => too_many(s),
            None => Resp::json(401, &json!({ "error": "that code is not right — check the clock on your phone", "why": "code" })),
        };
    };
    limits::clear(&st.db, &mk);
    if let Err(e) = store_totp(st, &account, &seed, Some(now), step) {
        return Resp::json(500, &json!({ "error": e }));
    }
    let codes = match new_recovery(st, &account) {
        Ok(c) => c,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    super::audit(st, Entry::new("totp.enroll").account(&account).ip(ip).target("account", &account));
    super::audit(st, Entry::new("recovery.issue").account(&account).ip(ip).detail(json!({ "count": RECOVERY_CODES })));
    let did = match session::create_device(st, &account, "admin", "claim", ip, ua, true) {
        Ok(d) => d,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    claim::complete(st, &account, &did, ip);
    super::audit(st, Entry::new("auth.login").account(&account).device(&did).ip(ip).detail(json!({ "via": "claim", "second": "totp" })));
    match session::issue(st, &did, ip) {
        Ok(i) => session::set_cookies(st, Resp::json(200, &json!({ "recovery_codes": codes, "device": did, "next": "/" })), &i),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

// ---- F2: sign-in ----------------------------------------------------------------------------

fn new_mfa_ticket(st: &State, account: &str, first: &'static str) -> String {
    new_mfa_ticket_via(st, account, first, None)
}

/// A first factor passed (password, OAuth): the ticket for the second.
pub fn new_mfa_ticket_via(st: &State, account: &str, first: &'static str, provider: Option<&str>) -> String {
    let t = b64u(&random_bytes::<32>());
    st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).insert(
        sha256_hex(t.as_bytes()),
        MfaTicket { account: account.into(), expires: now_ms() + st.idp.t.mfa_ticket_ms, first, provider: provider.map(str::to_string) },
    );
    t
}

/// A live (unexpired) second-factor ticket, without using it up.
pub fn peek_mfa(st: &State, ticket: &str) -> Option<MfaTicket> {
    let now = now_ms();
    st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).get(&sha256_hex(ticket.as_bytes())).cloned().filter(|t| t.expires > now)
}

/// Use a second-factor ticket up (true = it was live and is gone now).
pub fn take_mfa(st: &State, ticket: &str) -> Option<MfaTicket> {
    let now = now_ms();
    st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).remove(&sha256_hex(ticket.as_bytes())).filter(|t| t.expires > now)
}

/// The second factors this account can give: TOTP + recovery codes (+ passkey when it has one).
fn mfa_list(st: &State, account: &str, totp_enrolled: bool) -> Vec<&'static str> {
    let mut v = if totp_enrolled { vec!["totp", "recovery"] } else { vec!["totp"] };
    if passkey::count(st, account) > 0 {
        v.push("passkey");
    }
    v
}

/// What the second step of a sign-in offers: `{mfa:[…]}`, or `{mfa, enroll:{…}}` after a console
/// 2FA reset (a new authenticator is enrolled now — mandatory).
fn mfa_offer(st: &State, account: &str, ticket: Option<&str>) -> Resp {
    let mut body = json!({});
    if let Some(t) = ticket {
        body["mfa_ticket"] = json!(t);
    }
    match totp_row(st, account) {
        Some((_, _, Some(_))) => body["mfa"] = json!(mfa_list(st, account, true)),
        _ => {
            let seed = random_bytes::<20>();
            if let Err(e) = store_totp(st, account, &seed, None, 0) {
                return Resp::json(500, &json!({ "error": e }));
            }
            let email: Option<String> = st.db.with(|c| c.query_row("SELECT email FROM accounts WHERE id = ?1", [account], |r| r.get(0))).ok().flatten();
            body["mfa"] = json!(mfa_list(st, account, false));
            body["enroll"] = totp_view(st, email.as_deref().unwrap_or(""), &seed);
        }
    }
    Resp::json(200, &body)
}

/// POST /t/auth/mfa/options {mfa_ticket} → what the second step offers (the OAuth path lands on
/// /login#mfa=… and asks here).
pub fn mfa_options(st: &State, ticket: &str) -> Resp {
    match peek_mfa(st, ticket) {
        Some(t) => {
            let mut r = mfa_offer(st, &t.account, None);
            if let Some(p) = t.provider.as_deref() {
                if let Ok(mut v) = serde_json::from_slice::<Value>(&r.body) {
                    v["via"] = json!(p);
                    r = Resp::json(r.status, &v);
                }
            }
            r
        }
        None => Resp::json(401, &json!({ "error": "this sign-in expired — start again", "why": "ticket" })),
    }
}

/// POST /t/auth/login {email, password} → {mfa_ticket, mfa:[…]} or {mfa_ticket, enroll:{…}}.
/// Unknown email and wrong password answer alike, after the same argon2 work.
pub async fn login(st: &State, email: &str, pw: &str, ip: IpAddr) -> Resp {
    if !st.claimed() {
        return Resp::json(409, &json!({ "error": "this trunk is not claimed yet", "why": "unclaimed" }));
    }
    if st.lockdown() {
        return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
    }
    let now = now_ms();
    let norm = norm_email(email).unwrap_or_else(|| email.trim().to_lowercase());
    let pk = limits::pw_key(&norm);
    let nk = limits::net_key(ip);
    if let Some(s) = limits::locked(&st.db, &nk, now).or_else(|| limits::locked(&st.db, &pk, now)) {
        return too_many(s);
    }
    let acc = account_by_email(st, &norm);
    let ok = match &acc {
        Some((_, Some(h), status)) if status == "active" => st.idp.hasher.verify(pw, h).await,
        _ => st.idp.hasher.verify_dummy(pw).await,
    };
    if !ok {
        let lock = limits::fail(&st.db, &pk, Kind::Password, &st.idp.t, now_ms());
        let nlock = limits::fail(&st.db, &nk, Kind::Net, &st.idp.t, now_ms());
        let mut e = Entry::new("auth.login_fail").ip(ip).detail(json!({ "step": "password" }));
        if let Some((id, _, _)) = &acc {
            e = e.account(id);
        }
        super::audit(st, e);
        if let Some(s) = lock {
            let mut e = Entry::new("lockout.password").ip(ip).detail(json!({ "seconds": s }));
            if let Some((id, _, _)) = &acc {
                e = e.account(id);
            }
            super::audit(st, e);
            return too_many(s);
        }
        if let Some(s) = nlock {
            super::audit(st, Entry::new("lockout.net").ip(ip).detail(json!({ "seconds": s })));
            return too_many(s);
        }
        return generic_fail();
    }
    limits::clear(&st.db, &pk);
    let (account, _, _) = acc.expect("verified");
    let ticket = new_mfa_ticket(st, &account, "password");
    // 2FA reset from the console: the offer enrols a new authenticator now (mandatory)
    mfa_offer(st, &account, Some(&ticket))
}

/// POST /t/auth/mfa {mfa_ticket, totp | recovery} → cookies + a new device (admin: the admin's own
/// second factor happened on it).
pub fn mfa(st: &State, ticket: &str, totp_code: Option<&str>, recovery: Option<&str>, ip: IpAddr, ua: &str) -> Resp {
    if st.lockdown() {
        return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
    }
    let now = now_ms();
    let key = sha256_hex(ticket.as_bytes());
    let t = st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
    let Some(t) = t.filter(|t| t.expires > now) else {
        return Resp::json(401, &json!({ "error": "this sign-in expired — start again", "why": "ticket" }));
    };
    let account = t.account.clone();
    let enrolling = matches!(totp_row(st, &account), Some((_, _, None)));
    let mut extra = json!({});
    if enrolling {
        let Some(code) = totp_code else { return Resp::json(400, &json!({ "error": "enter the 6-digit code from your authenticator", "why": "code" })) };
        let mk = limits::mfa_key(&account);
        if let Some(s) = limits::locked(&st.db, &mk, now).or_else(|| limits::locked(&st.db, &limits::net_key(ip), now)) {
            return too_many(s);
        }
        let (seed, _, _) = totp_row(st, &account).expect("pending");
        let Some(step) = totp::verify(&seed, code, now / 1000, 0) else {
            let lock = limits::fail(&st.db, &mk, Kind::Mfa, &st.idp.t, now);
            limits::fail(&st.db, &limits::net_key(ip), Kind::Net, &st.idp.t, now);
            super::audit(st, Entry::new("totp.confirm_fail").account(&account).ip(ip));
            return match lock {
                Some(s) => too_many(s),
                None => Resp::json(401, &json!({ "error": "that code is not right", "why": "code" })),
            };
        };
        limits::clear(&st.db, &mk);
        if let Err(e) = store_totp(st, &account, &seed, Some(now), step) {
            return Resp::json(500, &json!({ "error": e }));
        }
        let codes = new_recovery(st, &account).unwrap_or_default();
        super::audit(st, Entry::new("totp.enroll").account(&account).ip(ip).target("account", &account));
        super::audit(st, Entry::new("recovery.issue").account(&account).ip(ip).detail(json!({ "count": RECOVERY_CODES })));
        extra = json!({ "recovery_codes": codes });
    } else {
        match second_factor(st, &account, totp_code, recovery, ip, "auth") {
            Ok("recovery") => extra = json!({ "recovery_left": recovery_left(st, &account) }),
            Ok(_) => {}
            Err(r) => return r,
        }
    }
    if st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).remove(&key).is_none() {
        // a racing request (a passkey, another tab) used the ticket first
        return Resp::json(401, &json!({ "error": "this sign-in expired — start again", "why": "ticket" }));
    }
    let second = if recovery.is_some_and(|r| !r.trim().is_empty()) && totp_code.is_none_or(|c| c.trim().is_empty()) { "recovery" } else { "totp" };
    complete_login(st, &account, t.first, t.provider.as_deref(), second, ip, ua, extra)
}

/// Both factors passed: a new device with the account's role (the admin's own second factor
/// happened on it), the audit entry, cookies.
pub fn complete_login(st: &State, account: &str, first: &str, provider: Option<&str>, second: &str, ip: IpAddr, ua: &str, extra: Value) -> Resp {
    let role: String = st.db.with(|c| c.query_row("SELECT role FROM accounts WHERE id = ?1", [account], |r| r.get(0))).unwrap_or_else(|_| "member".into());
    let did = match session::create_device(st, account, &role, "login", ip, ua, true) {
        Ok(d) => d,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    let mut detail = json!({ "first": first, "second": second });
    if let Some(p) = provider {
        detail["provider"] = json!(p);
    }
    super::audit(st, Entry::new("auth.login").account(account).device(&did).ip(ip).detail(detail));
    let mut body = json!({ "ok": true, "device": did, "next": "/" });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        b.extend(e.clone());
    }
    match session::issue(st, &did, ip) {
        Ok(i) => session::set_cookies(st, Resp::json(200, &body), &i),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

/// POST /t/auth/step-up {totp | recovery}
pub fn step_up(st: &State, who: &Who, totp_code: Option<&str>, recovery: Option<&str>, ip: IpAddr) -> Resp {
    match second_factor(st, &who.account, totp_code, recovery, ip, "step_up") {
        Ok(kind) => {
            session::mark_2fa(st, &who.did);
            super::audit(st, Entry::new("auth.step_up").account(&who.account).device(&who.did).ip(ip).detail(json!({ "second": kind })));
            Resp::json(200, &json!({ "ok": true, "fresh_until": now_ms() + st.idp.t.fresh_ms, "recovery_left": recovery_left(st, &who.account) }))
        }
        Err(r) => r,
    }
}

// ---- /t/account -------------------------------------------------------------------------------

pub fn view(st: &State, who: &Who) -> Value {
    let totp = totp_row(st, &who.account);
    let has_pw: bool = st
        .db
        .with(|c| c.query_row("SELECT pw_hash IS NOT NULL FROM accounts WHERE id = ?1", [&who.account], |r| r.get(0)))
        .unwrap_or(false);
    json!({
        "account": { "id": who.account, "email": who.email, "role": who.role },
        "device": who.view(st),
        "password": has_pw,
        "totp": { "enrolled": totp.as_ref().is_some_and(|t| t.2.is_some()), "enrolled_at": totp.and_then(|t| t.2) },
        "recovery": { "left": recovery_left(st, &who.account), "total": RECOVERY_CODES },
        "passkeys": passkey::list(st, &who.account),
        "passkeys_ready": true,
        "oauth": oauth_ids(st, &who.account),
        "fresh_s": st.idp.t.fresh_ms / 1000,
    })
}

/// The OAuth identities bound to the account: `[{provider, issuer, email, created_at}]`.
fn oauth_ids(st: &State, account: &str) -> Vec<Value> {
    st.db
        .with(|c| {
            let mut s = c.prepare("SELECT issuer, email, created_at FROM oauth_ids WHERE account_id = ?1 ORDER BY created_at")?;
            let v = s
                .query_map([account], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default()
        .into_iter()
        .map(|(iss, email, at)| {
            let provider = st.cfg.oauth.iter().find(|(k, p)| p.issuer_of(k) == iss).map(|(k, p)| (k.clone(), p.display_of(k)));
            json!({ "provider": provider.as_ref().map(|p| p.0.clone()), "name": provider.map(|p| p.1).unwrap_or_else(|| iss.clone()), "issuer": iss, "email": email, "created_at": at })
        })
        .collect()
}

/// POST /t/account/password {current, new} (fresh)
pub async fn change_password(st: &State, who: &Who, current: &str, new: &str, ip: IpAddr) -> Resp {
    if !who.fresh(st) {
        return session::step_up_needed();
    }
    let email = who.email.clone().unwrap_or_default();
    let pk = limits::pw_key(&email);
    let now = now_ms();
    if let Some(s) = limits::locked(&st.db, &pk, now) {
        return too_many(s);
    }
    let stored: Option<String> = st.db.with(|c| c.query_row("SELECT pw_hash FROM accounts WHERE id = ?1", [&who.account], |r| r.get(0))).ok().flatten();
    let ok = match stored {
        Some(h) => st.idp.hasher.verify(current, &h).await,
        None => false,
    };
    if !ok {
        if let Some(s) = limits::fail(&st.db, &pk, Kind::Password, &st.idp.t, now_ms()) {
            return too_many(s);
        }
        return Resp::json(401, &json!({ "error": "the current password is not right", "why": "credentials" }));
    }
    if let Err(why) = password::policy(new, &email) {
        return Resp::json(400, &json!({ "error": why, "why": "password" }));
    }
    let h = st.idp.hasher.hash(new).await;
    let _ = st.db.with(|c| c.execute("UPDATE accounts SET pw_hash = ?1 WHERE id = ?2", params![h, who.account]));
    limits::clear(&st.db, &pk);
    super::audit(st, Entry::new("account.password").account(&who.account).device(&who.did).ip(ip).target("account", &who.account));
    Resp::json(200, &json!({ "ok": true }))
}

/// POST /t/account/totp/reset (fresh) → a new authenticator to confirm; the old one keeps working
/// until the confirm.
pub fn totp_reset(st: &State, who: &Who) -> Resp {
    if !who.fresh(st) {
        return session::step_up_needed();
    }
    let seed = random_bytes::<20>().to_vec();
    st.idp.totp_pending.lock().unwrap_or_else(|e| e.into_inner()).insert(who.account.clone(), (seed.clone(), now_ms()));
    Resp::json(200, &totp_view(st, who.email.as_deref().unwrap_or(""), &seed))
}

/// POST /t/account/totp/confirm {code} (fresh)
pub fn totp_reset_confirm(st: &State, who: &Who, code: &str, ip: IpAddr) -> Resp {
    if !who.fresh(st) {
        return session::step_up_needed();
    }
    let pending = st.idp.totp_pending.lock().unwrap_or_else(|e| e.into_inner()).get(&who.account).cloned();
    let Some((seed, _)) = pending else { return Resp::json(409, &json!({ "error": "start the authenticator reset first", "why": "state" })) };
    let now = now_ms();
    let mk = limits::mfa_key(&who.account);
    if let Some(s) = limits::locked(&st.db, &mk, now) {
        return too_many(s);
    }
    let Some(step) = totp::verify(&seed, code, now / 1000, 0) else {
        if let Some(s) = limits::fail(&st.db, &mk, Kind::Mfa, &st.idp.t, now) {
            return too_many(s);
        }
        return Resp::json(401, &json!({ "error": "that code is not right", "why": "code" }));
    };
    if let Err(e) = store_totp(st, &who.account, &seed, Some(now), step) {
        return Resp::json(500, &json!({ "error": e }));
    }
    st.idp.totp_pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&who.account);
    super::audit(st, Entry::new("totp.reset").account(&who.account).device(&who.did).ip(ip).target("account", &who.account));
    Resp::json(200, &json!({ "ok": true }))
}

/// POST /t/account/recovery/regenerate (fresh) → 10 new codes, shown once.
pub fn recovery_regenerate(st: &State, who: &Who, ip: IpAddr) -> Resp {
    if !who.fresh(st) {
        return session::step_up_needed();
    }
    match new_recovery(st, &who.account) {
        Ok(codes) => {
            super::audit(st, Entry::new("recovery.issue").account(&who.account).device(&who.did).ip(ip).detail(json!({ "count": RECOVERY_CODES })));
            Resp::json(200, &json!({ "recovery_codes": codes }))
        }
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

// ---- console ------------------------------------------------------------------------------------

pub fn list(st: &State) -> Vec<Value> {
    st.db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT a.id, a.email, a.role, a.status, a.created_at, t.enrolled_at,
                        (SELECT count(*) FROM recovery_codes r WHERE r.account_id = a.id AND r.used_at IS NULL),
                        (SELECT count(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL)
                 FROM accounts a LEFT JOIN totp t ON t.account_id = a.id ORDER BY a.created_at",
            )?;
            let v = s
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "email": r.get::<_, Option<String>>(1)?, "role": r.get::<_, String>(2)?,
                        "status": r.get::<_, String>(3)?, "created_at": r.get::<_, i64>(4)?, "totp_enrolled_at": r.get::<_, Option<i64>>(5)?,
                        "recovery_left": r.get::<_, i64>(6)?, "devices": r.get::<_, i64>(7)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default()
}

/// The account a console command names (by email or id; the only one when not named).
pub fn resolve(st: &State, who: Option<&str>) -> Result<(String, Option<String>), String> {
    let rows: Vec<(String, Option<String>)> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT id, email FROM accounts")?;
            let v = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    match who {
        Some(w) => {
            let w = w.trim().to_lowercase();
            rows.into_iter().find(|(id, e)| *id == w || e.as_deref() == Some(w.as_str())).ok_or_else(|| format!("no account '{w}'"))
        }
        None => match rows.len() {
            0 => Err("no account yet (the trunk is not claimed)".into()),
            1 => Ok(rows.into_iter().next().unwrap()),
            _ => Err("name the account (email or id)".into()),
        },
    }
}

pub fn console_reset_2fa(st: &State, who: Option<&str>) -> Result<String, String> {
    let (id, email) = resolve(st, who)?;
    st.db.with(|c| {
        c.execute("DELETE FROM totp WHERE account_id = ?1", [&id])?;
        c.execute("DELETE FROM recovery_codes WHERE account_id = ?1", [&id])
    })?;
    limits::clear(&st.db, &limits::mfa_key(&id));
    super::audit(st, Entry::new("account.reset_2fa").target("account", &id).detail(json!({ "via": "console" })));
    Ok(format!(
        "2FA reset for {}: the authenticator and the recovery codes are gone; the next sign-in enrols a new authenticator",
        email.unwrap_or(id)
    ))
}

pub async fn console_reset_password(st: &State, who: Option<&str>) -> Result<String, String> {
    let (id, email) = resolve(st, who)?;
    // printed once on the console, never logged; change it in /account after signing in
    let pw: String = (0..20).map(|_| ALPHA[random_below(32) as usize] as char).collect();
    let pw = format!("{}-{}-{}-{}-{}", &pw[..4], &pw[4..8], &pw[8..12], &pw[12..16], &pw[16..]);
    let h = st.idp.hasher.hash(&pw).await;
    st.db.with(|c| c.execute("UPDATE accounts SET pw_hash = ?1 WHERE id = ?2", params![h, id]))?;
    if let Some(e) = &email {
        limits::clear(&st.db, &limits::pw_key(e));
    }
    super::audit(st, Entry::new("account.reset_password").target("account", &id).detail(json!({ "via": "console" })));
    Ok(format!("new password for {}: {pw}\n(shown once; your authenticator is still needed to sign in)", email.unwrap_or(id)))
}

pub fn console_unlock(st: &State, who: Option<&str>) -> Result<String, String> {
    let (id, email) = resolve(st, who)?;
    let mut n = limits::clear_prefix(&st.db, &limits::mfa_key(&id));
    if let Some(e) = &email {
        n += limits::clear_prefix(&st.db, &limits::pw_key(e));
    }
    super::audit(st, Entry::new("account.unlock").target("account", &id).detail(json!({ "via": "console", "cleared": n })));
    Ok(format!("unlocked {} ({n} lock{} cleared)", email.unwrap_or(id), if n == 1 { "" } else { "s" }))
}
