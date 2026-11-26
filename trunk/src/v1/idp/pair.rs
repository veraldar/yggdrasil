//! Phone pairing by single-use QR (spec §4.1 item 7, §5.4, §5.6 F5, §6 `pair_tokens`, §7 `/t/pair/*`,
//! §13 B2–B5, storyboard step 6B).
//!
//! One QR pairs one phone: `bfnp-` + 16 B in the fragment `/pair#v=2&t=…` (never in logs/history).
//! Consumed atomically on first redeem; second scan → 410 `used` (kept 1 h). Regenerate burns the
//! previous token and mints a fresh one; close burns it; auto-refreshes every 300 s while open.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::json;

use super::audit::Entry;
use super::devices::clean_device_name;
use super::limits::{self, Kind};
use super::qr;
use super::session::{self, Who};
use crate::v1::crypto::{new_id, secret, sha256_hex};
use crate::v1::db::now_ms;
use crate::v1::http::Resp;
use crate::v1::server::State;

struct Minted {
    id: String,
    url: String,
    /// the fragment token itself (`bfnp-`…), for rigs (the page never needs it: the QR is the url)
    token: String,
    qr_svg: String,
    expires_in: i64,
    role: String,
}

fn mint_row(st: &State, account: &str, minted_by: &str, role: &str, ip: Option<IpAddr>) -> Result<Minted, String> {
    let now = now_ms();
    let ttl = st.idp.t.pair_ttl_ms;
    let id = new_id("qr");
    let raw = secret("bfnp-", 16);
    let hash = sha256_hex(raw.as_bytes());
    st.db.with(|c| {
        c.execute(
            "INSERT INTO pair_tokens (id, hash, minted_by_device, account_id, role, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, hash, minted_by, account, role, now, now + ttl],
        )
        .map(|_| ())
    })?;
    let url = format!("{}/pair#v=2&t={raw}", st.cfg.origin());
    let qr_svg = qr::svg(&url);
    let mut e = Entry::new("pair.qr_mint")
        .account(account)
        .target("pair_token", &id)
        .detail(json!({ "role": role, "ttl_s": ttl / 1000 }));
    if minted_by != "console" {
        e = e.device(minted_by);
    }
    if let Some(ip) = ip {
        e = e.ip(ip);
    }
    super::audit(st, e);
    Ok(Minted { id, url, token: raw, qr_svg, expires_in: ttl / 1000, role: role.to_string() })
}

fn burn_row(st: &State, id: &str, account: Option<&str>, by_device: Option<&str>, why: &str, ip: Option<IpAddr>) -> bool {
    let now = now_ms();
    let n = st
        .db
        .with(|c| {
            c.execute(
                "UPDATE pair_tokens SET burned_at = ?1, burn_why = ?2 WHERE id = ?3 AND consumed_at IS NULL AND burned_at IS NULL",
                params![now, why, id],
            )
        })
        .unwrap_or(0);
    if n > 0 {
        let mut e = Entry::new("pair.qr_burn").target("pair_token", id).detail(json!({ "why": why }));
        if let Some(a) = account {
            e = e.account(a);
        }
        if let Some(d) = by_device {
            e = e.device(d);
        }
        if let Some(ip) = ip {
            e = e.ip(ip);
        }
        super::audit(st, e);
    }
    n > 0
}

fn require_admin_fresh(st: &State, who: &Who) -> Result<(), Resp> {
    if who.role != "admin" {
        return Err(Resp::json(403, &json!({ "error": "admin only", "why": "role" })));
    }
    if !who.fresh(st) {
        return Err(session::step_up_needed());
    }
    Ok(())
}

/// POST /t/pair/qr — admin + fresh step-up. Always mints a `member` QR.
pub fn mint_http(st: &State, who: &Who, ip: IpAddr) -> Resp {
    if let Err(r) = require_admin_fresh(st, who) {
        return r;
    }
    match mint_row(st, &who.account, &who.did, "member", Some(ip)) {
        Ok(m) => Resp::json(200, &json!({ "id": m.id, "url": m.url, "token": m.token, "qr_svg": m.qr_svg, "expires_in": m.expires_in, "role": m.role })),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

/// POST /t/pair/qr/:id/regenerate — admin + fresh step-up. Burns the old QR and mints a fresh one.
pub fn regenerate(st: &State, who: &Who, old_id: &str, ip: IpAddr) -> Resp {
    if let Err(r) = require_admin_fresh(st, who) {
        return r;
    }
    burn_row(st, old_id, Some(&who.account), Some(&who.did), "regenerated", Some(ip));
    match mint_row(st, &who.account, &who.did, "member", Some(ip)) {
        Ok(m) => Resp::json(200, &json!({ "id": m.id, "url": m.url, "token": m.token, "qr_svg": m.qr_svg, "expires_in": m.expires_in, "role": m.role })),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

/// DELETE /t/pair/qr/:id — admin. Burns an open QR when the dialog closes.
pub fn close(st: &State, who: &Who, id: &str, ip: IpAddr) -> Resp {
    if who.role != "admin" {
        return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
    }
    let burned = burn_row(st, id, Some(&who.account), Some(&who.did), "closed", Some(ip));
    Resp::json(200, &json!({ "ok": true, "burned": burned }))
}

/// GET /t/pair/qr/:id — admin. Status for the dialog: waiting / joined <name> · member / burned / expired.
pub fn status(st: &State, who: &Who, id: &str) -> Resp {
    if who.role != "admin" {
        return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
    }
    let row: Option<(String, i64, Option<i64>, Option<String>, Option<i64>, Option<String>)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT role, expires_at, consumed_at, consumed_by_device, burned_at, burn_why
                 FROM pair_tokens WHERE id = ?1 AND account_id = ?2",
                params![id, who.account],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((role, expires_at, consumed_at, consumed_by, burned_at, burn_why)) = row else {
        return Resp::json(404, &json!({ "error": "no such QR" }));
    };
    if consumed_at.is_some() {
        let dev_id = consumed_by.unwrap_or_default();
        let dev_name: String = st
            .db
            .with(|c| c.query_row("SELECT name FROM devices WHERE id = ?1", [&dev_id], |r| r.get(0)).optional())
            .ok()
            .flatten()
            .unwrap_or_else(|| "phone".into());
        return Resp::json(200, &json!({ "status": "joined", "device_id": dev_id, "device_name": dev_name, "role": role }));
    }
    if burned_at.is_some() {
        return Resp::json(200, &json!({ "status": "burned", "why": burn_why.unwrap_or_else(|| "closed".into()) }));
    }
    let now = now_ms();
    if expires_at <= now {
        return Resp::json(200, &json!({ "status": "expired", "expires_in": 0 }));
    }
    Resp::json(200, &json!({ "status": "waiting", "expires_in": (expires_at - now) / 1000 }))
}

/// POST /t/pair/redeem `{token, name?}` — unauthenticated phone redeeming a QR.
/// Second scan → 410 `used`; burned → 410 `burned`; expired → 410 `expired`.
pub fn redeem(st: &State, token: &str, name: Option<&str>, ip: IpAddr, ua: &str) -> Resp {
    if !st.claimed() {
        return Resp::json(409, &json!({ "error": "this trunk is not claimed yet", "why": "unclaimed" }));
    }
    if st.lockdown() {
        return Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" }));
    }
    let now = now_ms();
    let nk = limits::net_key(ip);
    if let Some(s) = limits::locked(&st.db, &nk, now) {
        return Resp::json(429, &json!({ "error": "too many attempts — wait and try again", "why": "locked", "retry_after": s }))
            .header("Retry-After", &s.to_string());
    }
    let token = token.trim();
    if !token.starts_with("bfnp-") || token.len() < 20 {
        limits::fail(&st.db, &nk, Kind::Net, &st.idp.t, now);
        return Resp::json(400, &json!({ "error": "this QR is not valid", "why": "invalid" }));
    }
    let hash = sha256_hex(token.as_bytes());
    let row: Option<(String, String, String, String, i64, Option<i64>, Option<i64>)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT id, account_id, minted_by_device, role, expires_at, consumed_at, burned_at
                 FROM pair_tokens WHERE hash = ?1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((id, account, minted_by, role, expires_at, consumed_at, burned_at)) = row else {
        limits::fail(&st.db, &nk, Kind::Net, &st.idp.t, now);
        super::audit(st, Entry::new("pair.qr_redeem_fail").ip(ip).detail(json!({ "why": "unknown" })));
        return Resp::json(410, &json!({ "error": "this QR is not valid or has expired", "why": "expired" }));
    };
    if consumed_at.is_some() {
        super::audit(st, Entry::new("pair.qr_redeem_fail").account(&account).ip(ip).target("pair_token", &id).detail(json!({ "why": "used" })));
        return Resp::json(410, &json!({ "error": "this QR was already used — ask for a new one", "why": "used" }));
    }
    if burned_at.is_some() {
        super::audit(st, Entry::new("pair.qr_redeem_fail").account(&account).ip(ip).target("pair_token", &id).detail(json!({ "why": "burned" })));
        return Resp::json(410, &json!({ "error": "this QR was cancelled — scan the new one", "why": "burned" }));
    }
    if expires_at <= now {
        super::audit(st, Entry::new("pair.qr_redeem_fail").account(&account).ip(ip).target("pair_token", &id).detail(json!({ "why": "expired" })));
        return Resp::json(410, &json!({ "error": "this QR expired — ask for a new one", "why": "expired" }));
    }
    // §8 Roles: a QR-paired phone did not do 2FA on this device (`two_fa = false`)
    let did = match session::create_device(st, &account, &role, "qr", ip, ua, false) {
        Ok(d) => d,
        Err(e) => return Resp::json(500, &json!({ "error": e })),
    };
    if let Some(custom) = name.and_then(clean_device_name) {
        let _ = st.db.with(|c| c.execute("UPDATE devices SET name = ?1 WHERE id = ?2", params![custom, did]));
    }
    // Atomic single-use consume: if another scan beat us, revoke the just-created device and return 410 `used`
    let won = st
        .db
        .with(|c| {
            c.execute(
                "UPDATE pair_tokens SET consumed_at = ?1, consumed_by_device = ?2
                 WHERE id = ?3 AND consumed_at IS NULL AND burned_at IS NULL AND expires_at > ?1",
                params![now, did, id],
            )
        })
        .unwrap_or(0)
        == 1;
    if !won {
        let _ = st.db.with(|c| c.execute("DELETE FROM devices WHERE id = ?1", [&did]));
        return Resp::json(410, &json!({ "error": "this QR was already used", "why": "used" }));
    }
    let dev_name: String = st
        .db
        .with(|c| c.query_row("SELECT name FROM devices WHERE id = ?1", [&did], |r| r.get(0)).optional())
        .ok()
        .flatten()
        .unwrap_or_else(|| "phone".into());
    super::audit(
        st,
        Entry::new("pair.qr_redeem")
            .account(&account)
            .device(&did)
            .ip(ip)
            .target("pair_token", &id)
            .detail(json!({ "minted_by": minted_by, "role": role, "name": dev_name })),
    );
    match session::issue(st, &did, ip) {
        Ok(i) => session::set_cookies(
            st,
            Resp::json(200, &json!({ "ok": true, "device": { "id": did, "name": dev_name, "role": role }, "next": "/" })),
            &i,
        ),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

/// Keep "used" (and burned/expired) rows for 1 h (B2) so a second scan answers 410 `used`, then prune.
pub fn prune(st: &State, now: i64) {
    let cut = now - st.idp.t.pair_used_keep_ms;
    let _ = st.db.with(|c| {
        c.execute(
            "DELETE FROM pair_tokens WHERE (consumed_at IS NOT NULL AND consumed_at < ?1)
             OR (burned_at IS NOT NULL AND burned_at < ?1)
             OR (consumed_at IS NULL AND burned_at IS NULL AND expires_at < ?1)",
            [cut],
        )
    });
}

/// Console `trunk-ctl devices pair-qr [--role member|admin]`.
pub fn console_mint_qr(st: &State, role: &str) -> Result<String, String> {
    if !st.claimed() {
        return Err("trunk is not claimed yet".into());
    }
    if !matches!(role, "member" | "admin") {
        return Err("role must be member or admin".into());
    }
    let account: String = st
        .db
        .with(|c| c.query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0)).optional())
        .map_err(|e| e.to_string())?
        .ok_or("no account found")?;
    let m = mint_row(st, &account, "console", role, None)?;
    Ok(json!({ "id": m.id, "url": m.url, "role": m.role, "expires_in": m.expires_in }).to_string())
}
