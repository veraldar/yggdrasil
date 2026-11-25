//! The trunk's own pages (spec §5.3, C8): embedded HTML + CSS + vanilla JS in the live app look
//! (tokens.css + brand.css + Commit Mono, copied by `sync-assets.sh`, `data-theme="utopia"`),
//! the §8 CSP, nothing third-party. M1: `/claim`, `/login`, `/account`, `/offline` and the
//! empty-trunk view of `/` (storyboard steps 1, 2a–2c, 3).

use std::sync::Arc;

use crate::v1::http::{Req, Resp};
use crate::v1::paseto::Why;
use crate::v1::server::{Incoming, State};

/// Every page name the trunk answers itself (never relayed). M3/M4 fill in the rest.
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

const TOKENS_CSS: &[u8] = include_bytes!("assets/tokens.css");
const BRAND_CSS: &[u8] = include_bytes!("assets/brand.css");
const SHELL_CSS: &[u8] = include_bytes!("assets/shell.css");
const SHELL_JS: &[u8] = include_bytes!("assets/shell.js");
const MONO_400: &[u8] = include_bytes!("assets/CommitMono-400-Regular.otf");
const MONO_700: &[u8] = include_bytes!("assets/CommitMono-700-Regular.otf");

const CLAIM: &str = include_str!("assets/claim.html");
const CLAIMED: &str = include_str!("assets/claimed.html");
const LOGIN: &str = include_str!("assets/login.html");
const ACCOUNT: &str = include_str!("assets/account.html");
const OFFLINE: &str = include_str!("assets/offline.html");
const EMPTY: &str = include_str!("assets/empty.html");

/// `GET /t/s/<name>`
pub fn asset(name: &str) -> Resp {
    let (ctype, body): (&str, &[u8]) = match name {
        "tokens.css" => ("text/css; charset=utf-8", TOKENS_CSS),
        "brand.css" => ("text/css; charset=utf-8", BRAND_CSS),
        "shell.css" => ("text/css; charset=utf-8", SHELL_CSS),
        "shell.js" => ("text/javascript; charset=utf-8", SHELL_JS),
        "CommitMono-400-Regular.otf" => ("font/otf", MONO_400),
        "CommitMono-700-Regular.otf" => ("font/otf", MONO_700),
        _ => return Resp::text(404, "no such asset\n"),
    };
    Resp::new(200, ctype, body).header("Cache-Control", "public, max-age=3600")
}

/// Percent-encode for a query value (everything but unreserved and `/`).
pub fn url_enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// The whole document around a page body (`{{HOST}}` / `{{ORIGIN}}` filled in, escaped).
pub fn document(st: &State, page: &str, title: &str, body: &str) -> String {
    let body = body.replace("{{HOST}}", &esc(&st.cfg.host())).replace("{{ORIGIN}}", &esc(&st.cfg.origin()));
    format!(
        "<!doctype html>\n<html lang=\"en\" data-theme=\"utopia\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n\
<meta name=\"referrer\" content=\"no-referrer\">\n<meta name=\"color-scheme\" content=\"light\">\n\
<title>{}</title>\n<link rel=\"stylesheet\" href=\"/t/s/tokens.css\">\n<link rel=\"stylesheet\" href=\"/t/s/brand.css\">\n\
<link rel=\"stylesheet\" href=\"/t/s/shell.css\">\n<script src=\"/t/s/shell.js\" defer></script>\n</head>\n\
<body class=\"oz\" data-page=\"{page}\">\n<main>\n{body}\n</main>\n</body>\n</html>\n",
        esc(title)
    )
}

fn html(st: &State, status: u16, page: &str, title: &str, body: &str) -> Resp {
    Resp::html(status, document(st, page, title, body))
}

/// The empty-trunk page, the offline page … for a signed-in device.
pub fn empty_trunk(st: &State) -> Resp {
    html(st, 200, "empty", "BIFROST · install a root", EMPTY)
}

pub async fn page(st: Arc<State>, inc: Incoming) {
    let route = inc.req.route().trim_end_matches('/').to_string();
    let access = st.check_access(&inc.req, inc.ip);
    // a token that only needs a refresh still gets the page (its script refreshes)
    let signed_in = matches!(access, Ok(_) | Err(Why::Expired) | Err(Why::Region));
    let claimed = st.claimed();
    let r = match route.as_str() {
        "/claim" if claimed => html(&st, 410, "claimed", "BIFROST · claimed", CLAIMED),
        "/claim" => html(&st, 200, "claim", "BIFROST · claim this trunk", CLAIM),
        _ if !claimed => Resp::redirect("/claim"),
        "/login" if access.is_ok() => Resp::redirect("/"),
        "/login" => html(&st, 200, "login", "BIFROST · sign in", LOGIN),
        "/account" if signed_in => html(&st, 200, "account", "BIFROST · account", ACCOUNT),
        "/account" => Resp::redirect("/login?next=/account"),
        "/offline" if signed_in => html(&st, 200, "offline", "BIFROST · offline", OFFLINE),
        "/offline" => Resp::redirect("/login"),
        _ => Resp::text(404, "not here yet\n"),
    };
    inc.answer(r).await
}

pub fn offline_for(req: &Req) -> Resp {
    if wants_page(req) {
        Resp::redirect("/offline")
    } else {
        Resp::json(503, &serde_json::json!({ "error": "no door root online", "why": "offline" }))
    }
}

/// Signed in, no root yet: `/` is the empty-trunk page; other pages go to `/`; the rest is 503.
pub fn empty_trunk_for(st: &State, req: &Req, np: &str) -> Resp {
    if !wants_page(req) {
        return Resp::json(503, &serde_json::json!({ "error": "no root connected yet", "why": "no-roots" }));
    }
    if np != "/" {
        return Resp::redirect("/");
    }
    empty_trunk(st)
}

/// `GET /.well-known/acme-challenge/<token>` from `acme_webroot`; the name must match
/// `[A-Za-z0-9_-]{16,128}`, nothing else is served (§7, §10).
pub fn acme(st: &State, raw: &str) -> Resp {
    let tok = raw.strip_prefix("/.well-known/acme-challenge/").unwrap_or("");
    let ok = (16..=128).contains(&tok.len()) && tok.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok || st.cfg.acme_webroot.is_empty() {
        return Resp::text(404, "not here\n");
    }
    let root = st.cfg.acme_webroot.trim_end_matches('/');
    match std::fs::read(format!("{root}/.well-known/acme-challenge/{tok}")).or_else(|_| std::fs::read(format!("{root}/{tok}"))) {
        Ok(b) if b.len() <= 4096 => Resp::new(200, "text/plain", b),
        _ => Resp::text(404, "not here\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C8: the embedded look is the live app's (re-run sync-assets.sh when the app's styles change).
    #[test]
    fn shell_assets_match_the_app() {
        let app = concat!(env!("CARGO_MANIFEST_DIR"), "/../branch");
        for (file, embedded) in [
            ("styles/tokens.css", TOKENS_CSS),
            ("styles/brand.css", BRAND_CSS),
            ("fonts/CommitMono-400-Regular.otf", MONO_400),
            ("fonts/CommitMono-700-Regular.otf", MONO_700),
        ] {
            let live = std::fs::read(format!("{app}/{file}")).unwrap();
            assert!(live == embedded, "{file} differs from the embedded copy — run trunk/src/v1/shell/sync-assets.sh");
        }
    }

    /// The CSP allows no inline script, no inline style, nothing from elsewhere.
    #[test]
    fn pages_have_no_inline_script_style_or_third_party() {
        for (name, body) in [("claim", CLAIM), ("claimed", CLAIMED), ("login", LOGIN), ("account", ACCOUNT), ("offline", OFFLINE), ("empty", EMPTY)] {
            let low = body.to_lowercase();
            assert!(!low.contains("<script"), "{name}: inline script");
            assert!(!low.contains("style="), "{name}: inline style");
            assert!(!low.contains("<style"), "{name}: inline style block");
            assert!(!low.contains(" on") || !regex_like_handler(&low), "{name}: inline event handler");
            assert!(!low.contains("http://") && !low.contains("https://"), "{name}: an absolute URL (third party?)");
        }
        let js = std::str::from_utf8(SHELL_JS).unwrap();
        assert!(!js.contains("http://") && !js.contains("https://"), "shell.js: an absolute URL");
        assert!(!js.contains("innerHTML") && !js.contains("eval("), "shell.js builds DOM nodes, never strings");
        let css = std::str::from_utf8(SHELL_CSS).unwrap();
        assert!(!css.contains("http://") && !css.contains("https://") && !css.contains("@import"), "shell.css: nothing from elsewhere");
    }

    fn regex_like_handler(s: &str) -> bool {
        ["onclick=", "onload=", "onsubmit=", "oninput=", "onchange=", "onerror="].iter().any(|h| s.contains(h))
    }

    #[test]
    fn is_page_and_escape() {
        assert!(is_page("/login") && is_page("/claim") && is_page("/auth/root") && !is_page("/loginx") && !is_page("/"));
        assert_eq!(esc("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    }
}
