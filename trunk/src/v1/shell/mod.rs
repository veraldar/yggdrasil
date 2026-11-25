//! The trunk's own pages (spec §5.3, C8): embedded HTML + CSS + vanilla JS, the live app look
//! (tokens.css, brand.css, Commit Mono — copied by `sync-assets.sh`), CSP of §8, nothing
//! third-party.

use crate::v1::http::{Req, Resp};
use crate::v1::server::{Incoming, State};

/// Every page name the trunk answers itself (never relayed). M1 serves login, claim, account,
/// offline and the empty-trunk view of `/`; the rest arrive with M3/M4.
pub const PAGES: &[&str] = &["/login", "/claim", "/account", "/offline", "/devices", "/pair", "/add-root", "/auth/root", "/audit"];

pub fn is_page(p: &str) -> bool {
    PAGES.iter().any(|x| p == *x || p.strip_prefix(x).is_some_and(|r| r.starts_with('/')))
}

/// A browser navigation (a page), as opposed to an API or asset call.
pub fn wants_page(req: &Req) -> bool {
    matches!(req.method.as_str(), "GET" | "HEAD")
        && (req.header("sec-fetch-dest").is_some_and(|d| d == "document")
            || req.header("accept").is_some_and(|a| a.contains("text/html")))
}

pub async fn page(_st: std::sync::Arc<State>, inc: Incoming) {
    let r = Resp::html(200, "<!doctype html><title>trunk</title><p>trunk</p>");
    inc.answer(r).await
}

pub fn asset(_name: &str) -> Resp {
    Resp::text(404, "no such asset\n")
}

pub fn offline_for(req: &Req) -> Resp {
    if wants_page(req) {
        Resp::redirect("/offline")
    } else {
        Resp::json(503, &serde_json::json!({ "error": "no door root online", "why": "offline" }))
    }
}

/// Signed in, no root yet: `/` is the empty-trunk page; other pages go to `/`; the rest is 503.
pub fn empty_trunk_for(_st: &State, req: &Req, np: &str) -> Resp {
    if !wants_page(req) {
        return Resp::json(503, &serde_json::json!({ "error": "no root connected yet", "why": "no-roots" }));
    }
    if np != "/" {
        return Resp::redirect("/");
    }
    Resp::html(200, "<!doctype html><title>trunk</title><p>no roots connected yet</p>")
}

/// `/install/root.sh` · `/install/root.exe` — INSTALL serves the real ones (M6).
pub fn install_placeholder(st: &State, np: &str) -> Resp {
    match np {
        "/install/root.sh" => Resp::new(
            503,
            "text/plain; charset=utf-8",
            format!("#!/bin/sh\necho 'the root installer for {} is not built yet (v1 INSTALL stream)' >&2\nexit 1\n", st.cfg.origin()),
        ),
        "/install/root.exe" => Resp::text(503, "the Windows root installer is not built yet\n"),
        _ => Resp::text(404, "not here\n"),
    }
}

/// `GET /.well-known/acme-challenge/<token>` from `acme_webroot`; the name must match
/// `[A-Za-z0-9_-]{16,128}`, nothing else is served (§7, §10).
pub fn acme(st: &State, raw: &str) -> Resp {
    let tok = raw.strip_prefix("/.well-known/acme-challenge/").unwrap_or("");
    let ok = (16..=128).contains(&tok.len()) && tok.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok || st.cfg.acme_webroot.is_empty() {
        return Resp::text(404, "not here\n");
    }
    let p = format!("{}/.well-known/acme-challenge/{tok}", st.cfg.acme_webroot.trim_end_matches('/'));
    let p2 = format!("{}/{tok}", st.cfg.acme_webroot.trim_end_matches('/'));
    match std::fs::read(&p).or_else(|_| std::fs::read(&p2)) {
        Ok(b) if b.len() <= 4096 => Resp::new(200, "text/plain", b),
        _ => Resp::text(404, "not here\n"),
    }
}
