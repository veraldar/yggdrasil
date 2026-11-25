//! `/install/root.sh` · `/install/root.exe` (spec §5.3, §7): the trunk serves the root installer
//! with its own origin baked in. The script itself is the release's `root/install/root.sh` — but
//! served by the trunk it can never drift from what THIS trunk expects: the baked values are the
//! trunk's URL and its identity key (WIRE.md "Enrollment API" note). A 404 with a clear message
//! answers for `root.exe` until a Windows build lands in the release.
//!
//! `GET /install/root.sh` → 200 `application/x-sh` — the release's script, with
//! `TRUNK_URL_BAKED='<origin>'` and `TRUNK_KEY_BAKED='<trunk key b64url>` in place.
//! `GET /install/root.exe` → 404 (a build artifact, not embedded) — with the plain-words answer
//! the NSIS installer's page shows instead.
//!
//! The script is embedded with `include_str!` (no files on the VPS, no Node). Baking is a
//! line-replacement on the two baked markers, checked at build time: the source must carry them.

use super::http::Resp;
use super::server::State;

/// The release's `root/install/root.sh`, as shipped (unchanged, 0644).
pub const ROOT_SH: &str = include_str!("../../../root/install/root.sh");
/// `TRUNK_URL_BAKED='@TRUNK_URL@'` — the marker the trunk fills with its own origin.
const URL_MARKER: &str = "TRUNK_URL_BAKED='@TRUNK_URL@'";
/// `TRUNK_KEY_BAKED='@TRUNK_KEY@'` — the marker the trunk fills with its identity key.
const KEY_MARKER: &str = "TRUNK_KEY_BAKED='@TRUNK_KEY@'";

/// `/install/*` — `root.sh` baked, `root.exe` a clear 404, anything else 404.
pub fn serve(st: &State, raw: &str) -> Resp {
    let path = raw.split(['?', '#']).next().unwrap_or(raw).trim_end_matches('/');
    match path {
        "/install/root.sh" => root_sh(st),
        "/install/root.exe" => Resp::text(
            404,
            "no Windows installer is served by this trunk yet — build Veraldar-Setup-<version>.exe\n\
             (scripts/build-win.sh) and put it behind your web server, or install by hand inside WSL2:\n\
             curl -fsSL <this trunk>/install/root.sh | bash\n",
        ),
        _ => Resp::text(404, "not here\n"),
    }
}

/// The baked installer: this trunk's origin + identity key in the script's two markers.
pub fn root_sh(st: &State) -> Resp {
    if !ROOT_SH.contains(URL_MARKER) || !ROOT_SH.contains(KEY_MARKER) {
        // never happens with the shipped script; kept as a loud guard
        return Resp::text(500, "the embedded root.sh does not carry its bake markers\n");
    }
    let url = st.cfg.origin();
    let key = super::crypto::b64u(&st.trunk_key.public());
    let body = ROOT_SH.replacen(URL_MARKER, &format!("TRUNK_URL_BAKED='{url}'"), 1)
        .replacen(KEY_MARKER, &format!("TRUNK_KEY_BAKED='{key}'"), 1);
    Resp::new(200, "text/x-shellscript; charset=utf-8", body)
        .header("Content-Disposition", "attachment; filename=\"root.sh\"")
        .header("X-Content-Type-Options", "nosniff")
}

/// The empty-trunk page's installer text: the one line per system (storyboard step 3).
#[allow(dead_code)] // wired into the empty-trunk page when APP lands its final copy
pub fn install_line(st: &State) -> String {
    format!("curl -fsSL {}/install/root.sh | bash", st.cfg.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_script_carries_its_bake_markers() {
        assert!(ROOT_SH.contains(URL_MARKER), "root/install/root.sh must carry {URL_MARKER}");
        assert!(ROOT_SH.contains(KEY_MARKER), "root/install/root.sh must carry {KEY_MARKER}");
    }

    #[test]
    fn baking_replaces_the_baked_values() {
        // the script also carries an un-baked-copy guard ("$TRUNK" = '@TRUNK_URL@'): that stays,
        // it is the check that catches a script served unbaked
        let a = ROOT_SH.replacen(URL_MARKER, "TRUNK_URL_BAKED='https://t.example'", 1)
            .replacen(KEY_MARKER, "TRUNK_KEY_BAKED='ABC'", 1);
        assert!(!a.contains("TRUNK_KEY_BAKED='@TRUNK_KEY@'"));   // (the guard comparison keeps its marker)
        assert_eq!(a.matches("TRUNK_URL_BAKED='").count(), 1);
        assert_eq!(a.matches("TRUNK_KEY_BAKED='").count(), 1);
        assert!(a.contains("TRUNK_URL_BAKED='https://t.example'"));
    }

    #[test]
    fn root_exe_is_a_clear_404_not_an_empty_200() {
        // the words a person sees when the Windows build is not there
        let (st, _d) = crate::v1::idp::session::tests::test_state(false);
        let r = serve(&st, "/install/root.exe");
        assert_eq!(r.status, 404);
        let body = String::from_utf8_lossy(&r.body).to_string();
        assert!(body.contains("no Windows installer"), "{body}");
    }

    #[test]
    fn unknown_install_paths_404() {
        let (st, _d) = crate::v1::idp::session::tests::test_state(false);
        assert_eq!(serve(&st, "/install/root.sh").status, 200);
        assert_eq!(serve(&st, "/install/other.sh").status, 404);
        assert_eq!(serve(&st, "/install/root.sh?x=1").status, 200);
        assert_eq!(serve(&st, "/install/root.sh/").status, 200);
    }

    #[test]
    fn the_script_bakes_this_trunk() {
        let (st, _d) = crate::v1::idp::session::tests::test_state(false);
        let r = root_sh(&st);
        assert_eq!(r.status, 200);
        let body = String::from_utf8_lossy(&r.body).to_string();
        assert!(body.contains("TRUNK_URL_BAKED='https://ljoolq.veraldar.org'"), "the origin baked");
        let want = crate::v1::crypto::b64u(&st.trunk_key.public());
        assert!(body.contains(&format!("TRUNK_KEY_BAKED='{want}'")), "the trunk key baked");
        assert!(body.starts_with("#!/usr/bin/env bash"));
    }
}
