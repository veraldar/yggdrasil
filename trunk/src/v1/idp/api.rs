//! `/t/*` (spec §7) — the trunk's own API, answered here (WIRE's `/t/*` routes were offered to
//! `relay::route` first). Every write needs `Origin` = the trunk's origin (public_url or an
//! extra name); cookies are SameSite=Strict on top.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{account, claim, session};
use crate::v1::http::{Resp, MAX_BODY};
use crate::v1::relay;
use crate::v1::server::{Incoming, State};
use crate::v1::shell;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn opt<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// CSRF by Origin: a write must carry the trunk's own origin.
pub fn origin_ok(st: &State, inc: &Incoming) -> bool {
    match inc.req.header("origin") {
        Some(o) => st.cfg.write_origins().iter().any(|w| w.eq_ignore_ascii_case(o.trim())),
        None => false,
    }
}

pub async fn handle(st: Arc<State>, mut inc: Incoming) {
    let route = inc.req.route().to_string();
    let route = if route.len() > 3 { route.trim_end_matches('/').to_string() } else { route };
    let method = inc.req.method.clone();
    if let Some(name) = route.strip_prefix("/t/s/") {
        let r = shell::asset(name);
        return inc.answer(r).await;
    }
    let write = inc.req.is_write();
    if write && !origin_ok(&st, &inc) {
        return inc.answer(Resp::json(403, &json!({ "error": "this request did not come from the trunk's own page", "why": "origin" }))).await;
    }
    let body: Value = if write {
        match inc.body(MAX_BODY).await {
            Ok(b) if b.iter().all(|c| c.is_ascii_whitespace()) => json!({}),
            Ok(b) => match serde_json::from_slice::<Value>(&b) {
                Ok(v) if v.is_object() => v,
                _ => return inc.answer(Resp::json(400, &json!({ "error": "the body must be a JSON object" }))).await,
            },
            Err(r) => return inc.answer(r).await,
        }
    } else {
        json!({})
    };
    let ip = inc.ip;
    let ua = inc.req.header("user-agent").unwrap_or("").to_string();
    let r = match (method.as_str(), route.as_str()) {
        ("GET" | "HEAD", "/t/state") => state(&st),

        // F1 · claim
        ("POST", "/t/claim/begin") => match claim::begin(&st, s(&body, "code"), ip) {
            Ok((ticket, exp)) => Resp::json(200, &json!({ "ticket": ticket, "url": format!("{}/claim#t={ticket}", st.cfg.origin()), "expires_in": exp })),
            Err(e) => e.resp(),
        },
        ("POST", "/t/claim/ticket") => match claim::info(&st, s(&body, "ticket")) {
            Ok(v) => Resp::json(200, &v),
            Err(e) => e.resp(),
        },
        ("POST", "/t/claim/approve") => match claim::approve(&st, s(&body, "ticket"), ip) {
            Ok(()) => Resp::json(200, &json!({ "ok": true })),
            Err(e) => e.resp(),
        },
        ("POST", "/t/claim/refuse") => match claim::refuse(&st, s(&body, "ticket"), ip) {
            Ok(()) => Resp::json(200, &json!({ "ok": true })),
            Err(e) => e.resp(),
        },
        ("POST", "/t/auth/signup") => account::signup(&st, s(&body, "ticket"), s(&body, "email"), s(&body, "password"), ip).await,
        ("POST", "/t/auth/totp/confirm") => account::claim_totp_confirm(&st, s(&body, "ticket"), s(&body, "code"), ip, &ua),

        // F2 · sign in
        ("POST", "/t/auth/login") => account::login(&st, s(&body, "email"), s(&body, "password"), ip).await,
        ("POST", "/t/auth/mfa") => account::mfa(&st, s(&body, "mfa_ticket"), opt(&body, "totp"), opt(&body, "recovery"), ip, &ua),
        ("POST", "/t/auth/refresh") => {
            let raw = inc.req.cookie(session::REFRESH_COOKIE);
            match session::refresh(&st, raw.as_deref(), ip) {
                Ok(i) => session::set_cookies(&st, Resp::json(200, &json!({ "ok": true, "exp": i.access_exp })), &i),
                Err(e) => e.resp(),
            }
        }
        ("POST", "/t/auth/step-up") => match session::who(&st, &inc) {
            Ok(w) => account::step_up(&st, &w, opt(&body, "totp"), opt(&body, "recovery"), ip),
            Err(r) => r,
        },
        ("POST", "/t/auth/logout") => {
            if let Ok(w) = session::who(&st, &inc) {
                session::revoke_device(&st, &w.did, Some(&w.did), "signed out", Some(ip));
            } else if let Some(raw) = inc.req.cookie(session::REFRESH_COOKIE) {
                // an expired access token still signs out through its refresh token
                let h = crate::v1::crypto::sha256_hex(raw.as_bytes());
                let did: Option<String> = st
                    .db
                    .with(|c| {
                        use rusqlite::OptionalExtension as _;
                        c.query_row("SELECT device_id FROM refresh_tokens WHERE hash = ?1 AND retired_at IS NULL", [&h], |r| r.get(0)).optional()
                    })
                    .ok()
                    .flatten();
                if let Some(d) = did {
                    session::revoke_device(&st, &d, Some(&d), "signed out", Some(ip));
                }
            }
            session::clear_cookies(Resp::json(200, &json!({ "ok": true, "next": "/login" })))
        }
        ("GET" | "HEAD", "/t/me") => match session::who(&st, &inc) {
            Ok(w) => Resp::json(
                200,
                &json!({
                    "account": { "id": w.account, "email": w.email, "role": w.role },
                    "device": w.view(&st),
                    "trunk": { "id": st.trunk_id, "host": st.cfg.host(), "url": st.cfg.origin() },
                    "token": { "exp": w.claims.exp, "rgn": w.claims.rgn },
                    "has_roots": relay::has_roots(&st),
                }),
            ),
            Err(r) => r,
        },

        // 2FA management
        ("GET" | "HEAD", "/t/account") => match session::who(&st, &inc) {
            Ok(w) => Resp::json(200, &account::view(&st, &w)),
            Err(r) => r,
        },
        ("POST", "/t/account/password") => match session::who(&st, &inc) {
            Ok(w) => account::change_password(&st, &w, s(&body, "current"), s(&body, "new"), ip).await,
            Err(r) => r,
        },
        ("POST", "/t/account/totp/reset") => match session::who(&st, &inc) {
            Ok(w) => account::totp_reset(&st, &w),
            Err(r) => r,
        },
        ("POST", "/t/account/totp/confirm") => match session::who(&st, &inc) {
            Ok(w) => account::totp_reset_confirm(&st, &w, s(&body, "code"), ip),
            Err(r) => r,
        },
        ("POST", "/t/account/recovery/regenerate") => match session::who(&st, &inc) {
            Ok(w) => account::recovery_regenerate(&st, &w, ip),
            Err(r) => r,
        },
        (_, p) if KNOWN.contains(&p) => Resp::json(405, &json!({ "error": "method not allowed" })),
        _ => Resp::json(404, &json!({ "error": "not found" })),
    };
    inc.answer(r).await
}

const KNOWN: &[&str] = &[
    "/t/state", "/t/claim/begin", "/t/claim/ticket", "/t/claim/approve", "/t/claim/refuse", "/t/auth/signup",
    "/t/auth/totp/confirm", "/t/auth/login", "/t/auth/mfa", "/t/auth/refresh", "/t/auth/step-up", "/t/auth/logout",
    "/t/me", "/t/account", "/t/account/password", "/t/account/totp/reset", "/t/account/totp/confirm",
    "/t/account/recovery/regenerate",
];

/// GET /t/state — `{claimed, has_roots, lockdown, providers[]}` (anyone).
pub fn state(st: &State) -> Resp {
    let providers: Vec<&String> = st.cfg.oauth.keys().collect();
    Resp::json(
        200,
        &json!({
            "claimed": st.claimed(),
            "has_roots": relay::has_roots(st),
            "lockdown": st.lockdown(),
            "providers": providers,
        }),
    )
}
