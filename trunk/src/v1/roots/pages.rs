//! `/auth/root` (the desktop 1-tap card; `?e=<enrollment>`, a QR shortcut adds `#c=<code>`) and
//! `/add-root` (headless: enter the code the server prints) — storyboard step 4, the shell's look
//! (C8: tokens.css + brand.css + Commit Mono + shell.css, served by the shell at `/t/s/*`).
//! The frame is the shell's `document` (IDP); this copy of its head goes when the shell merges.

use super::super::http::Resp;
use super::super::paseto::Why;
use super::super::server::{Incoming, State};

const BODY: &str = include_str!("assets/auth-root.html");
const UI_JS: &str = include_str!("assets/ui.js");

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn document(st: &State, page: &str, title: &str) -> String {
    let body = BODY.replace("{{HOST}}", &esc(&st.cfg.host()));
    format!(
        "<!doctype html>\n<html lang=\"en\" data-theme=\"utopia\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n\
<meta name=\"referrer\" content=\"no-referrer\">\n<meta name=\"color-scheme\" content=\"light\">\n\
<title>{}</title>\n<link rel=\"stylesheet\" href=\"/t/s/tokens.css\">\n<link rel=\"stylesheet\" href=\"/t/s/brand.css\">\n\
<link rel=\"stylesheet\" href=\"/t/s/shell.css\">\n</head>\n\
<body class=\"oz\" data-page=\"{page}\">\n<main>\n{body}\n</main>\n</body>\n</html>\n",
        esc(title)
    )
}

/// The page for a signed-in device (an expired token still gets it: the shell refreshes);
/// anyone else goes to `/login` and comes back.
pub fn page(st: &State, inc: &Incoming, which: &str) -> Resp {
    let signed_in = matches!(st.check_access(&inc.req, inc.ip), Ok(_) | Err(Why::Expired) | Err(Why::Region));
    if !st.claimed() {
        return Resp::redirect("/claim");
    }
    if !signed_in {
        let next: String = inc.req.path.chars().filter(|c| c.is_ascii_graphic()).collect();
        return Resp::redirect(&format!("/login?next={}", percent_encode(&next)));
    }
    match which {
        "auth-root" => Resp::html(200, document(st, "auth-root", "BIFROST · connect this computer")),
        _ => Resp::html(200, document(st, "add-root", "BIFROST · add a root")),
    }
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn ui_js() -> Resp {
    Resp::new(200, "text/javascript; charset=utf-8", UI_JS).header("Cache-Control", "no-cache")
}
