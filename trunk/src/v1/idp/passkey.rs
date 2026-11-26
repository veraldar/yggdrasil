//! Passkeys (spec §4.1 item 2, §5.6 F2, §8 "Passkeys"): WebAuthn L2 through `webauthn-rs`.
//!
//! RP ID = `rp_id` (e.g. `veraldar.org`), accepted origins = public_url, each extra name and
//! `origins` — exact matches, so a passkey made on `ljoolq.veraldar.org` still works on
//! `ap.veraldar.org` after the move. User verification is required (a passkey is both factors).
//!
//!   enrol    admin device + fresh: POST /t/account/passkeys/begin → /finish
//!   remove   admin device + fresh: DELETE /t/account/passkeys/:id
//!   use      POST /t/auth/passkey/begin → /finish, `intent`:
//!              login    passwordless sign-in → a new admin device (the admin's own passkey on it)
//!              step-up  a signed-in device becomes fresh (600 s)
//!              mfa      the second factor after a password or OAuth first factor
//!
//! Each ceremony is one-use and short-lived (`auth_challenges`); the sign counter is checked
//! (`webauthn-rs` refuses a counter that did not move forward, the cloned-authenticator signal) and
//! stored after every use. Failures count toward the account's second-factor lockout (5 → 15 min)
//! and the network's.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use webauthn_rs::prelude::*;

use super::audit::Entry;
use super::challenge::{self, Kind as CKind, PutErr};
use super::limits::{self, Kind as LKind};
use super::session::{self, Who};
use super::account;
use crate::v1::crypto::{b64u, new_id, sha256, sha256_hex};
use crate::v1::db::now_ms;
use crate::v1::http::Resp;
use crate::v1::server::State;

pub const MAX_PER_ACCOUNT: i64 = 16;

/// The relying party for this trunk's config.
pub fn webauthn(st: &State) -> Result<Webauthn, String> {
    let origins = st.cfg.passkey_origins();
    let urls: Vec<Url> = origins.iter().map(|o| Url::parse(o).map_err(|e| format!("origin {o}: {e}"))).collect::<Result<_, _>>()?;
    let rp = st.cfg.rp_id();
    let first = urls.first().ok_or("no origin")?;
    let mut b = WebauthnBuilder::new(&rp, first)
        .map_err(|e| format!("webauthn: rp_id {rp} / {first}: {e}"))?
        .rp_name("BIFROST")
        .timeout(std::time::Duration::from_millis(st.idp.t.passkey_ttl_ms as u64));
    for u in &urls[1..] {
        b = b.append_allowed_origin(u);
    }
    b.build().map_err(|e| format!("webauthn: {e}"))
}

/// The account's WebAuthn user handle (stable, opaque: derived from the account id).
pub fn user_uuid(account: &str) -> Uuid {
    let h = sha256(format!("ygg-trunk-v1/webauthn-user\0{account}").as_bytes());
    Uuid::from_slice(&h[..16]).expect("16 bytes")
}

/// (row id, the stored credential)
fn rows(st: &State, account: &str) -> Vec<(String, Passkey)> {
    st.db
        .with(|c| {
            let mut s = c.prepare("SELECT id, public_key FROM passkeys WHERE account_id = ?1 ORDER BY created_at")?;
            let v = s.query_map([account], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(id, blob)| serde_json::from_slice::<Passkey>(&blob).ok().map(|p| (id, p)))
        .collect()
}

pub fn count(st: &State, account: &str) -> i64 {
    st.db.with(|c| c.query_row("SELECT count(*) FROM passkeys WHERE account_id = ?1", [account], |r| r.get(0))).unwrap_or(0)
}

/// `[{id, name, created_at, last_used, sign_count}]` (no key material).
pub fn list(st: &State, account: &str) -> Vec<Value> {
    st.db
        .with(|c| {
            let mut s = c.prepare("SELECT id, name, created_at, last_used, sign_count FROM passkeys WHERE account_id = ?1 ORDER BY created_at")?;
            let v = s
                .query_map([account], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "name": r.get::<_, Option<String>>(1)?, "created_at": r.get::<_, i64>(2)?,
                        "last_used": r.get::<_, Option<i64>>(3)?, "sign_count": r.get::<_, i64>(4)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default()
}

/// The one account (v1) a passwordless sign-in is for.
fn sole_account(st: &State) -> Option<String> {
    st.db
        .with(|c| c.query_row("SELECT id FROM accounts WHERE status = 'active' ORDER BY created_at LIMIT 1", [], |r| r.get(0)).optional())
        .ok()
        .flatten()
}

fn clean_name(n: Option<&str>, ua_default: &str) -> String {
    let n: String = n.unwrap_or("").chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect();
    if n.is_empty() {
        ua_default.chars().take(40).collect()
    } else {
        n
    }
}

fn too_many(s: i64) -> Resp {
    Resp::json(429, &json!({ "error": "too many attempts — wait and try again", "why": "locked", "retry_after": s })).header("Retry-After", &s.to_string())
}

fn busy() -> Resp {
    Resp::json(429, &json!({ "error": "too many passkey prompts in flight from your network — wait a minute", "why": "busy", "retry_after": 60 }))
        .header("Retry-After", "60")
}

fn bad_challenge() -> Resp {
    Resp::json(401, &json!({ "error": "this passkey prompt expired or was already used — try again", "why": "challenge" }))
}

/// A WebAuthn refusal → the audit's `why` (never shown to the browser).
fn classify(e: &WebauthnError) -> &'static str {
    match e {
        WebauthnError::CredentialPossibleCompromise => "counter",
        WebauthnError::InvalidRPOrigin => "origin",
        WebauthnError::InvalidRPIDHash => "rp_id",
        WebauthnError::UserNotVerified | WebauthnError::InconsistentUserVerificationPolicy => "uv",
        WebauthnError::UserNotPresent => "up",
        WebauthnError::MismatchedChallenge => "challenge",
        WebauthnError::CredentialNotFound => "credential",
        WebauthnError::AuthenticationFailure => "signature",
        WebauthnError::InvalidClientDataType => "type",
        WebauthnError::CredentialAlreadyExists | WebauthnError::CredentialExcludedFromRequest => "exists",
        _ => "invalid",
    }
}

// ---- enrol -----------------------------------------------------------------------------------------

fn admin_fresh(st: &State, who: &Who) -> Result<(), Resp> {
    if who.role != "admin" {
        return Err(Resp::json(403, &json!({ "error": "only an admin device can change passkeys", "why": "role" })));
    }
    if !who.fresh(st) {
        return Err(session::step_up_needed());
    }
    Ok(())
}

/// POST /t/account/passkeys/begin {name?} → {challenge, options}
pub fn register_begin(st: &State, who: &Who, name: Option<&str>, ip: IpAddr) -> Resp {
    if let Err(r) = admin_fresh(st, who) {
        return r;
    }
    if count(st, &who.account) >= MAX_PER_ACCOUNT {
        return Resp::json(409, &json!({ "error": format!("at most {MAX_PER_ACCOUNT} passkeys — remove one first"), "why": "full" }));
    }
    let wa = match webauthn(st) {
        Ok(w) => w,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    let exclude: Vec<CredentialID> = rows(st, &who.account).iter().map(|(_, p)| p.cred_id().clone()).collect();
    let user = who.email.clone().unwrap_or_else(|| "admin".into());
    let (ccr, reg) = match wa.start_passkey_registration(user_uuid(&who.account), &user, &user, Some(exclude)) {
        Ok(x) => x,
        Err(e) => return Resp::json(500, &json!({ "error": format!("webauthn: {e}") })),
    };
    let data = json!({ "reg": reg, "name": clean_name(name, &who.name) });
    match challenge::put(st, CKind::PasskeyRegister, Some(&who.account), Some(&who.did), ip, st.idp.t.passkey_ttl_ms, &data) {
        Ok(h) => Resp::json(200, &json!({ "challenge": h, "options": ccr })),
        Err(PutErr::Busy) => busy(),
        Err(PutErr::Db(e)) => Resp::json(500, &json!({ "error": e })),
    }
}

/// POST /t/account/passkeys/finish {challenge, credential, name?} → {ok, passkey}
pub fn register_finish(st: &State, who: &Who, handle: &str, credential: &Value, name: Option<&str>, ip: IpAddr) -> Resp {
    if let Err(r) = admin_fresh(st, who) {
        return r;
    }
    let Some(t) = challenge::take(st, handle, CKind::PasskeyRegister) else { return bad_challenge() };
    if t.account.as_deref() != Some(who.account.as_str()) || t.device.as_deref() != Some(who.did.as_str()) {
        return bad_challenge();
    }
    let reg: Option<PasskeyRegistration> = t.data.get("reg").cloned().and_then(|v| serde_json::from_value(v).ok());
    let cred: Option<RegisterPublicKeyCredential> = serde_json::from_value(credential.clone()).ok();
    let (Some(reg), Some(cred)) = (reg, cred) else {
        return Resp::json(400, &json!({ "error": "that is not a passkey answer", "why": "passkey" }));
    };
    let wa = match webauthn(st) {
        Ok(w) => w,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    let pk = match wa.finish_passkey_registration(&cred, &reg) {
        Ok(pk) => pk,
        Err(e) => {
            super::audit(st, Entry::new("passkey.add_fail").account(&who.account).device(&who.did).ip(ip).detail(json!({ "why": classify(&e) })));
            return Resp::json(400, &json!({ "error": "the passkey was not accepted — try again", "why": "passkey" }));
        }
    };
    let id = new_id("pk");
    let name = name.map(|n| clean_name(Some(n), &who.name)).unwrap_or_else(|| t.data.get("name").and_then(Value::as_str).unwrap_or("passkey").to_string());
    let blob = match serde_json::to_vec(&pk) {
        Ok(b) => b,
        Err(e) => return Resp::json(500, &json!({ "error": e.to_string() })),
    };
    let now = now_ms();
    let r = st.db.with(|c| {
        c.execute(
            "INSERT INTO passkeys (id, account_id, cred_id, public_key, sign_count, name, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
            params![id, who.account, b64u(pk.cred_id().as_ref()), blob, name, now],
        )
    });
    if r.is_err() {
        return Resp::json(409, &json!({ "error": "this passkey is already registered", "why": "exists" }));
    }
    super::audit(st, Entry::new("passkey.add").account(&who.account).device(&who.did).ip(ip).target("passkey", &id).detail(json!({ "name": name })));
    Resp::json(200, &json!({ "ok": true, "passkey": { "id": id, "name": name, "created_at": now, "last_used": null, "sign_count": 0 } }))
}

/// DELETE /t/account/passkeys/:id (admin + fresh)
pub fn remove(st: &State, who: &Who, id: &str, ip: IpAddr) -> Resp {
    if let Err(r) = admin_fresh(st, who) {
        return r;
    }
    let n = st.db.with(|c| c.execute("DELETE FROM passkeys WHERE id = ?1 AND account_id = ?2", params![id, who.account])).unwrap_or(0);
    if n == 0 {
        return Resp::json(404, &json!({ "error": "no such passkey", "why": "missing" }));
    }
    super::audit(st, Entry::new("passkey.remove").account(&who.account).device(&who.did).ip(ip).target("passkey", id));
    Resp::json(200, &json!({ "ok": true }))
}

// ---- use -----------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Login,
    StepUp,
    Mfa,
}

impl Intent {
    pub fn parse(s: &str) -> Option<Intent> {
        match s {
            "login" | "" => Some(Intent::Login),
            "step-up" | "step_up" => Some(Intent::StepUp),
            "mfa" => Some(Intent::Mfa),
            _ => None,
        }
    }
    fn kind(self) -> CKind {
        match self {
            Intent::Login => CKind::PasskeyLogin,
            Intent::StepUp => CKind::PasskeyStepUp,
            Intent::Mfa => CKind::PasskeyMfa,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Intent::Login => "login",
            Intent::StepUp => "step-up",
            Intent::Mfa => "mfa",
        }
    }
}

fn locked_out(st: &State, account: &str, ip: IpAddr) -> Option<Resp> {
    let now = now_ms();
    limits::locked(&st.db, &limits::mfa_key(account), now).or_else(|| limits::locked(&st.db, &limits::net_key(ip), now)).map(too_many)
}

/// POST /t/auth/passkey/begin {intent, mfa_ticket?} → {challenge, options}
pub fn auth_begin(st: &State, who: Result<Who, Resp>, intent: Intent, mfa_ticket: Option<&str>, ip: IpAddr) -> Resp {
    let (account, device, mfa_hash) = match intent {
        Intent::Login => {
            if !st.claimed() {
                return Resp::json(409, &json!({ "error": "this trunk is not claimed yet", "why": "unclaimed" }));
            }
            if st.lockdown() {
                return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
            }
            let Some(a) = sole_account(st) else { return Resp::json(409, &json!({ "error": "no account yet", "why": "unclaimed" })) };
            (a, None, None)
        }
        Intent::StepUp => match who {
            Ok(w) => (w.account.clone(), Some(w.did.clone()), None),
            Err(r) => return r,
        },
        Intent::Mfa => {
            if st.lockdown() {
                return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
            }
            let t = mfa_ticket.unwrap_or("");
            match account::peek_mfa(st, t) {
                Some(m) => (m.account, None, Some(sha256_hex(t.as_bytes()))),
                None => return Resp::json(401, &json!({ "error": "this sign-in expired — start again", "why": "ticket" })),
            }
        }
    };
    if let Some(r) = locked_out(st, &account, ip) {
        return r;
    }
    let creds: Vec<Passkey> = rows(st, &account).into_iter().map(|(_, p)| p).collect();
    if creds.is_empty() {
        return Resp::json(409, &json!({ "error": "no passkey is set up on this trunk yet — sign in another way, then add one in your account", "why": "no-passkey" }));
    }
    let wa = match webauthn(st) {
        Ok(w) => w,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    let (rcr, state) = match wa.start_passkey_authentication(&creds) {
        Ok(x) => x,
        Err(e) => return Resp::json(500, &json!({ "error": format!("webauthn: {e}") })),
    };
    let data = json!({ "auth": state, "mfa": mfa_hash });
    match challenge::put(st, intent.kind(), Some(&account), device.as_deref(), ip, st.idp.t.passkey_ttl_ms, &data) {
        Ok(h) => Resp::json(200, &json!({ "challenge": h, "options": rcr })),
        Err(PutErr::Busy) => busy(),
        Err(PutErr::Db(e)) => Resp::json(500, &json!({ "error": e })),
    }
}

/// A refused assertion: counts toward the account's second-factor lockout and the network's.
fn refused(st: &State, account: &str, intent: Intent, why: &str, ip: IpAddr) -> Resp {
    let now = now_ms();
    let lock = limits::fail(&st.db, &limits::mfa_key(account), LKind::Mfa, &st.idp.t, now);
    let nlock = limits::fail(&st.db, &limits::net_key(ip), LKind::Net, &st.idp.t, now);
    super::audit(st, Entry::new("auth.passkey_fail").account(account).ip(ip).detail(json!({ "intent": intent.as_str(), "why": why })));
    if let Some(s) = lock {
        super::audit(st, Entry::new("lockout.mfa").account(account).ip(ip).detail(json!({ "seconds": s })));
        return too_many(s);
    }
    if let Some(s) = nlock {
        super::audit(st, Entry::new("lockout.net").ip(ip).detail(json!({ "seconds": s })));
        return too_many(s);
    }
    Resp::json(401, &json!({ "error": "that passkey was not accepted", "why": "passkey" }))
}

/// POST /t/auth/passkey/finish {intent, challenge, credential, mfa_ticket?}
pub fn auth_finish(st: &State, who: Result<Who, Resp>, intent: Intent, handle: &str, credential: &Value, mfa_ticket: Option<&str>, ip: IpAddr, ua: &str) -> Resp {
    let Some(t) = challenge::take(st, handle, intent.kind()) else {
        super::audit(st, Entry::new("auth.passkey_fail").ip(ip).detail(json!({ "intent": intent.as_str(), "why": "challenge" })));
        if let Some(s) = limits::fail(&st.db, &limits::net_key(ip), LKind::Net, &st.idp.t, now_ms()) {
            return too_many(s);
        }
        return bad_challenge();
    };
    let Some(account) = t.account.clone() else { return bad_challenge() };
    // a step-up ceremony belongs to the device that began it
    if intent == Intent::StepUp {
        match &who {
            Ok(w) if t.device.as_deref() == Some(w.did.as_str()) => {}
            Ok(_) => return bad_challenge(),
            Err(r) => return r.clone(),
        }
    }
    if let Some(r) = locked_out(st, &account, ip) {
        return r;
    }
    let state: Option<PasskeyAuthentication> = t.data.get("auth").cloned().and_then(|v| serde_json::from_value(v).ok());
    let Some(state) = state else { return bad_challenge() };
    let Some(cred) = serde_json::from_value::<PublicKeyCredential>(credential.clone()).ok() else {
        return refused(st, &account, intent, "malformed", ip);
    };
    let wa = match webauthn(st) {
        Ok(w) => w,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    let res = match wa.finish_passkey_authentication(&cred, &state) {
        Ok(r) => r,
        Err(e) => return refused(st, &account, intent, classify(&e), ip),
    };
    if !res.user_verified() {
        return refused(st, &account, intent, "uv", ip);
    }
    // store the moved counter (and backup state) on the credential that answered
    let now = now_ms();
    let mut used = None;
    for (id, mut pk) in rows(st, &account) {
        if pk.cred_id() == res.cred_id() {
            pk.update_credential(&res);
            if let Ok(blob) = serde_json::to_vec(&pk) {
                let _ = st.db.with(|c| {
                    c.execute(
                        "UPDATE passkeys SET public_key = ?1, sign_count = ?2, last_used = ?3 WHERE id = ?4",
                        params![blob, res.counter() as i64, now, id],
                    )
                });
            }
            used = Some(id);
        }
    }
    let Some(pk_id) = used else { return refused(st, &account, intent, "credential", ip) };
    limits::clear(&st.db, &limits::mfa_key(&account));
    match intent {
        Intent::Login => {
            if st.lockdown() {
                return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
            }
            let status: Option<String> = st.db.with(|c| c.query_row("SELECT status FROM accounts WHERE id = ?1", [&account], |r| r.get(0)).optional()).ok().flatten();
            if status.as_deref() != Some("active") {
                return refused(st, &account, intent, "disabled", ip);
            }
            account::complete_login(st, &account, "passkey", None, "passkey", ip, ua, json!({ "passkey": pk_id }))
        }
        Intent::StepUp => {
            let w = who.expect("checked above");
            session::mark_2fa(st, &w.did);
            super::audit(st, Entry::new("auth.step_up").account(&account).device(&w.did).ip(ip).detail(json!({ "second": "passkey", "passkey": pk_id })));
            Resp::json(200, &json!({ "ok": true, "fresh_until": now + st.idp.t.fresh_ms, "recovery_left": account::recovery_left(st, &account) }))
        }
        Intent::Mfa => {
            let tk = mfa_ticket.unwrap_or("");
            let want = t.data.get("mfa").and_then(Value::as_str).unwrap_or("");
            if want.is_empty() || sha256_hex(tk.as_bytes()) != want {
                return bad_challenge();
            }
            let Some(m) = account::take_mfa(st, tk) else {
                return Resp::json(401, &json!({ "error": "this sign-in expired — start again", "why": "ticket" }));
            };
            if st.lockdown() {
                return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
            }
            account::complete_login(st, &account, m.first, m.provider.as_deref(), "passkey", ip, ua, json!({ "passkey": pk_id }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::idp::session::tests::test_state;

    fn admin(st: &State) -> (String, String) {
        st.db
            .with(|c| c.execute("INSERT INTO accounts (id, email, pw_hash, role, created_at) VALUES ('acc_p', 'o@example.org', 'x', 'admin', 0)", []))
            .unwrap();
        st.db.meta_set("claimed_at", "1").unwrap();
        let did = session::create_device(st, "acc_p", "admin", "login", "203.0.113.5".parse().unwrap(), "", true).unwrap();
        ("acc_p".into(), did)
    }

    fn who(st: &State, did: &str) -> Who {
        let i = session::issue(st, did, "203.0.113.5".parse().unwrap()).unwrap();
        let req = crate::v1::http::parse_head(format!("GET /t/me HTTP/1.1\r\nCookie: bifrost_device={}\r\n\r\n", i.access).as_bytes()).unwrap();
        let c = st.check_access(&req, "203.0.113.5".parse().unwrap()).unwrap();
        session::who_claims(st, &c).unwrap()
    }

    fn body(r: &Resp) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn the_relying_party_follows_the_config() {
        let (mut st, dir) = test_state(true);
        assert!(webauthn(&st).is_ok());
        st.cfg.rp_id = "veraldar.org".into();
        st.cfg.extra_names = vec!["ap.veraldar.org".into()];
        let wa = webauthn(&st).unwrap();
        let o: Vec<String> = wa.get_allowed_origins().iter().map(|u| u.as_str().trim_end_matches('/').to_string()).collect();
        assert_eq!(o, vec!["https://ljoolq.veraldar.org", "https://ap.veraldar.org"]);
        st.cfg.rp_id = "example.org".into();
        assert!(webauthn(&st).is_err(), "an RP ID that does not cover the origin");
        // the user handle is stable per account and differs between accounts
        assert_eq!(user_uuid("acc_a"), user_uuid("acc_a"));
        assert_ne!(user_uuid("acc_a"), user_uuid("acc_b"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn enrol_needs_an_admin_device_and_fresh_2fa() {
        let (st, dir) = test_state(true);
        let (_, did) = admin(&st);
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let mut w = who(&st, &did);
        let r = register_begin(&st, &w, Some("phone"), ip);
        assert_eq!(r.status, 200);
        let b = body(&r);
        assert_eq!(b["options"]["publicKey"]["rp"]["id"], "ljoolq.veraldar.org");
        assert_eq!(b["options"]["publicKey"]["authenticatorSelection"]["userVerification"], "required");
        // the browser's answer must be for this ceremony: garbage is refused and the handle is spent
        let h = b["challenge"].as_str().unwrap().to_string();
        assert_eq!(register_finish(&st, &w, &h, &json!({ "id": "x" }), None, ip).status, 400);
        assert_eq!(register_finish(&st, &w, &h, &json!({ "id": "x" }), None, ip).status, 401, "one use");
        // stale 2FA → step-up; a member device → 403
        w.last_2fa_at = Some(0);
        assert_eq!(body(&register_begin(&st, &w, None, ip))["why"], "step-up");
        w.last_2fa_at = Some(now_ms());
        w.role = "member".into();
        assert_eq!(register_begin(&st, &w, None, ip).status, 403);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sign_in_needs_a_passkey_and_a_live_ceremony() {
        let (st, dir) = test_state(true);
        let (acc, did) = admin(&st);
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let r = auth_begin(&st, Err(session::deny(crate::v1::paseto::Why::Missing)), Intent::Login, None, ip);
        assert_eq!((r.status, body(&r)["why"].clone()), (409, json!("no-passkey")));
        // a step-up needs a signed-in device
        let r = auth_begin(&st, Err(session::deny(crate::v1::paseto::Why::Missing)), Intent::StepUp, None, ip);
        assert_eq!(r.status, 401);
        // mfa needs a live second-factor ticket
        let r = auth_begin(&st, Ok(who(&st, &did)), Intent::Mfa, Some("nope"), ip);
        assert_eq!(body(&r)["why"], "ticket");
        // an unknown handle is refused (and counted for the network)
        let r = auth_finish(&st, Err(session::deny(crate::v1::paseto::Why::Missing)), Intent::Login, "nope", &json!({}), None, ip, "");
        assert_eq!(body(&r)["why"], "challenge");
        let last = super::super::audit::tail(&st.db, 1);
        assert_eq!(last[0]["action"], "auth.passkey_fail");
        assert_eq!(count(&st, &acc), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
