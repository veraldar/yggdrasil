//! `/t/*` (spec §7) — the trunk's own API, answered here (WIRE's `/t/*` routes were offered to
//! `relay::route` first). Every write needs `Origin` = the trunk's origin (public_url or an
//! extra name); cookies are SameSite=Strict on top.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{account, audit, claim, devices, oauth, pair, passkey, session};
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
        // an OAuth claim came back from the provider: its pending authenticator (QR + key)
        ("POST", "/t/claim/totp") => account::claim_totp_view(&st, s(&body, "ticket")),

        // M4 · OAuth (code flow + PKCE S256 + state + nonce; the redirect URI is …/callback)
        ("GET" | "HEAD", p) if oauth_path(p, "start").is_some() => {
            let pid = oauth_path(p, "start").unwrap_or_default();
            let intent = inc.req.query("intent").unwrap_or_else(|| "login".into());
            let next = inc.req.query("next");
            match oauth::start(&st, &pid, &intent, None, next.as_deref(), &inc.req, ip).await {
                Ok((url, bind)) => oauth::bind_cookie(Resp::redirect(&url), &bind, st.idp.t.oauth_ttl_ms / 1000),
                // a plain link: back to the page with a generic error
                Err(_) => Resp::redirect(if intent == "claim" { "/claim" } else { "/login#e=oauth" }),
            }
        }
        ("POST", p) if oauth_path(p, "start").is_some() => {
            let pid = oauth_path(p, "start").unwrap_or_default();
            match oauth::start(&st, &pid, opt(&body, "intent").unwrap_or("login"), opt(&body, "ticket"), opt(&body, "next"), &inc.req, ip).await {
                Ok((url, bind)) => oauth::bind_cookie(Resp::json(200, &json!({ "url": url })), &bind, st.idp.t.oauth_ttl_ms / 1000),
                Err(r) => r,
            }
        }
        ("GET" | "HEAD", p) if oauth_path(p, "callback").is_some() => {
            let pid = oauth_path(p, "callback").unwrap_or_default();
            oauth::callback(&st, &pid, &inc.req, ip).await
        }

        // M4 · passkeys: sign-in, step-up, the second factor (spec §7 names: /t/passkey/options|verify)
        ("POST", "/t/auth/passkey/begin" | "/t/passkey/options") => match passkey::Intent::parse(s(&body, "intent")) {
            Some(i) => passkey::auth_begin(&st, session::who(&st, &inc), i, opt(&body, "mfa_ticket"), ip),
            None => Resp::json(400, &json!({ "error": "intent must be login, step-up or mfa", "why": "intent" })),
        },
        ("POST", "/t/auth/passkey/finish" | "/t/passkey/verify") => match passkey::Intent::parse(s(&body, "intent")) {
            Some(i) => passkey::auth_finish(
                &st,
                session::who(&st, &inc),
                i,
                s(&body, "challenge"),
                body.get("credential").unwrap_or(&Value::Null),
                opt(&body, "mfa_ticket"),
                ip,
                &ua,
            ),
            None => Resp::json(400, &json!({ "error": "intent must be login, step-up or mfa", "why": "intent" })),
        },
        ("POST", "/t/auth/mfa/options") => account::mfa_options(&st, s(&body, "mfa_ticket")),

        // F2 · sign in
        ("POST", "/t/auth/login") => account::login(&st, s(&body, "email"), s(&body, "password"), ip).await,
        ("POST", "/t/auth/mfa") => account::mfa(&st, s(&body, "mfa_ticket"), opt(&body, "totp"), opt(&body, "recovery"), ip, &ua),
        ("POST", "/t/auth/refresh") => {
            let raw = inc.req.cookie(session::REFRESH_COOKIE);
            match session::refresh(&st, raw.as_deref(), ip) {
                Ok(i) => session::set_cookies(&st, Resp::json(200, &json!({ "ok": true, "exp": i.access_exp, "access_token": i.access })), &i),
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
        ("GET" | "HEAD", "/t/account/passkeys") => match session::who(&st, &inc) {
            Ok(w) => Resp::json(200, &json!({ "passkeys": passkey::list(&st, &w.account) })),
            Err(r) => r,
        },
        ("POST", "/t/account/passkeys/begin" | "/t/account/passkeys/options") => match session::who(&st, &inc) {
            Ok(w) => passkey::register_begin(&st, &w, opt(&body, "name"), ip),
            Err(r) => r,
        },
        ("POST", "/t/account/passkeys/finish" | "/t/account/passkeys") => match session::who(&st, &inc) {
            Ok(w) => passkey::register_finish(&st, &w, s(&body, "challenge"), body.get("credential").unwrap_or(&Value::Null), opt(&body, "name"), ip),
            Err(r) => r,
        },
        ("DELETE", p) if p.starts_with("/t/account/passkeys/") && !p["/t/account/passkeys/".len()..].contains('/') => {
            let id = &p["/t/account/passkeys/".len()..];
            match session::who(&st, &inc) {
                Ok(w) => passkey::remove(&st, &w, id, ip),
                Err(r) => r,
            }
        }

        // M3 · devices, kill-switch, QR pairing, audit
        ("GET" | "HEAD", "/t/devices") => match session::who(&st, &inc) {
            Ok(w) => devices::list(&st, &w),
            Err(r) => r,
        },
        ("PATCH", p) if p.starts_with("/t/devices/") && !p["/t/devices/".len()..].contains('/') => {
            let id = &p["/t/devices/".len()..];
            match session::who(&st, &inc) {
                Ok(w) => devices::patch(&st, &w, id, opt(&body, "name"), opt(&body, "role"), ip),
                Err(r) => r,
            }
        }
        ("DELETE", p) if p.starts_with("/t/devices/") && !p["/t/devices/".len()..].contains('/') => {
            let id = &p["/t/devices/".len()..];
            match session::who(&st, &inc) {
                Ok(w) => devices::revoke(&st, &w, id, ip),
                Err(r) => r,
            }
        }
        ("POST", "/t/kill") => match session::who(&st, &inc) {
            Ok(w) => {
                let lockdown = body.get("lockdown").and_then(Value::as_bool).unwrap_or(false);
                devices::kill_http(&st, &w, lockdown, ip)
            }
            Err(r) => r,
        },
        ("POST", "/t/pair/qr") => match session::who(&st, &inc) {
            Ok(w) => pair::mint_http(&st, &w, ip),
            Err(r) => r,
        },
        ("POST", p) if p.starts_with("/t/pair/qr/") && p.ends_with("/regenerate") => {
            let id = &p["/t/pair/qr/".len()..p.len() - "/regenerate".len()];
            if id.is_empty() || id.contains('/') {
                Resp::json(404, &json!({ "error": "not found" }))
            } else {
                match session::who(&st, &inc) {
                    Ok(w) => pair::regenerate(&st, &w, id, ip),
                    Err(r) => r,
                }
            }
        }
        ("DELETE", p) if p.starts_with("/t/pair/qr/") && !p["/t/pair/qr/".len()..].contains('/') => {
            let id = &p["/t/pair/qr/".len()..];
            match session::who(&st, &inc) {
                Ok(w) => pair::close(&st, &w, id, ip),
                Err(r) => r,
            }
        }
        ("GET" | "HEAD", p) if p.starts_with("/t/pair/qr/") && !p["/t/pair/qr/".len()..].contains('/') => {
            let id = &p["/t/pair/qr/".len()..];
            match session::who(&st, &inc) {
                Ok(w) => pair::status(&st, &w, id),
                Err(r) => r,
            }
        }
        ("POST", "/t/pair/redeem") => {
            let tok = opt(&body, "token").or_else(|| opt(&body, "t")).unwrap_or("");
            pair::redeem(&st, tok, opt(&body, "name"), ip, &ua)
        }
        ("GET" | "HEAD", "/t/audit") => match session::who(&st, &inc) {
            Ok(w) if w.role == "admin" => {
                let limit = inc.req.query("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(100);
                let before = inc.req.query("before").and_then(|v| v.parse::<i64>().ok());
                let action = inc.req.query("action");
                let (entries, total) = audit::list_page(&st.db, limit, before, action.as_deref());
                let chain_ok = audit::verify(&st.db).is_ok();
                let actions = if before.is_none() && action.is_none() { audit::actions(&st.db) } else { vec![] };
                Resp::json(200, &json!({ "entries": entries, "total": total, "chain_ok": chain_ok, "actions": actions }))
            }
            Ok(_) => Resp::json(403, &json!({ "error": "admin only", "why": "role" })),
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
    "/t/account/recovery/regenerate", "/t/devices", "/t/kill", "/t/pair/qr", "/t/pair/redeem", "/t/audit",
    "/t/claim/totp", "/t/auth/passkey/begin", "/t/auth/passkey/finish", "/t/passkey/options", "/t/passkey/verify",
    "/t/auth/mfa/options", "/t/account/passkeys", "/t/account/passkeys/begin", "/t/account/passkeys/finish",
    "/t/account/passkeys/options",
];

/// `/t/auth/oauth/<provider>/<what>` → the provider id.
fn oauth_path(p: &str, what: &str) -> Option<String> {
    let rest = p.strip_prefix("/t/auth/oauth/")?;
    let (id, w) = rest.split_once('/')?;
    (w == what && !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')).then(|| id.to_string())
}

/// GET /t/state — `{claimed, has_roots, lockdown, providers[]}` (anyone).
pub fn state(st: &State) -> Resp {
    let providers = oauth::public_list(st);
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
