//! `trunk.toml` — the v1 trunk server's config (CONTRACTS.md C2). Unknown keys are an error.

use std::net::IpAddr;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// origin used for `iss`, Origin checks and links, e.g. "https://ljoolq.veraldar.org"
    pub public_url: String,
    #[serde(default)]
    pub extra_names: Vec<String>,
    /// phase 1: plain http behind a proxy (Caddy); "" = off
    #[serde(default)]
    pub listen_http: String,
    /// phase 2: own TLS; "" = off
    #[serde(default)]
    pub listen_tls: String,
    /// phase 2: framed STUN / ICE-TCP (WIRE); "" = off
    #[serde(default)]
    pub listen_ice: String,
    /// the TLS listener reads a PROXY v1 line first (behind sni-443)
    #[serde(default)]
    pub proxy_protocol: bool,
    /// XFF (plain http) / PROXY (tls) are believed only from these peers
    #[serde(default)]
    pub trusted_proxies: Vec<String>,
    pub db: String,
    pub state_dir: String,
    /// `trunk-kek`, oauth secrets, the claim code file
    pub cred_dir: String,
    pub ctl_socket: String,
    #[serde(default)]
    pub acme_webroot: String,
    #[serde(default)]
    pub rp_id: String,
    #[serde(default)]
    pub origins: Vec<String>,
    /// who may ask GET /t/ice/owner (the Incus bridge)
    #[serde(default)]
    pub ice_owner_from: Vec<String>,
    /// TLS certificate + key (listen_tls only)
    #[serde(default)]
    pub cert_path: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub auth: Auth,
    #[serde(default)]
    pub oauth: std::collections::BTreeMap<String, OAuth>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    /// "refresh" (default): a region change needs the refresh credential; "repair": a new sign-in
    #[serde(default = "default_region_policy")]
    pub region_policy: String,
}

impl Default for Auth {
    fn default() -> Self {
        Auth { region_policy: default_region_policy() }
    }
}

fn default_region_policy() -> String {
    "refresh".into()
}

/// `[oauth.<id>]` (C2 + M4). `[oauth.google]` and `[oauth.github]` are presets: only `client_id`
/// and `client_secret_file` are needed. Any other id is a generic OpenID Connect provider found by
/// discovery at `<issuer>/.well-known/openid-configuration`. The endpoint overrides exist for
/// providers without discovery and for rigs (a mock provider on loopback).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuth {
    /// required for a generic provider; the presets know theirs
    #[serde(default)]
    pub issuer: String,
    pub client_id: String,
    /// a file name inside cred_dir (the secret itself never sits in trunk.toml or a log)
    pub client_secret_file: String,
    /// the button's label ("Google"); default: from the preset or the id
    #[serde(default)]
    pub display: Option<String>,
    /// "oidc" (ID token + JWKS) or "github" (GitHub's OAuth apps: no ID token, verified e-mail
    /// from the API); default: "github" for `[oauth.github]`, else "oidc"
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub scopes: Option<String>,
    #[serde(default)]
    pub authorize_url: Option<String>,
    #[serde(default)]
    pub token_url: Option<String>,
    /// kind "github": the REST API base (default https://api.github.com)
    #[serde(default)]
    pub api_url: Option<String>,
}

impl OAuth {
    /// "oidc" | "github"
    pub fn kind_of(&self, id: &str) -> &str {
        match self.kind.as_deref() {
            Some(k) => k,
            None if id == "github" => "github",
            None => "oidc",
        }
    }

    pub fn issuer_of(&self, id: &str) -> String {
        if !self.issuer.is_empty() {
            return self.issuer.trim_end_matches('/').to_string();
        }
        match (id, self.kind_of(id)) {
            ("google", "oidc") => "https://accounts.google.com".into(),
            (_, "github") => "https://github.com".into(),
            _ => String::new(),
        }
    }

    pub fn display_of(&self, id: &str) -> String {
        if let Some(d) = self.display.as_deref().filter(|d| !d.trim().is_empty()) {
            return d.trim().chars().take(32).collect();
        }
        match id {
            "google" => "Google".into(),
            "github" => "GitHub".into(),
            _ => {
                let mut c = id.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            }
        }
    }
}

/// An endpoint a provider may use: https, or plain http to a loopback address (a rig's mock).
pub fn provider_url_ok(u: &str) -> bool {
    // it ends up in a Location header: no control characters, no spaces
    if u.is_empty() || u.len() > 2048 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Some(o) = origin_of(u) else { return false };
    if o.starts_with("https://") {
        return true;
    }
    matches!(strip_port(o.trim_start_matches("http://")), "127.0.0.1" | "localhost" | "[::1]")
}

/// "host:8080" → "host"; "[::1]:80" → "[::1]"; "host" → "host".
pub fn strip_port(h: &str) -> &str {
    match h.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && (!host.contains(':') || host.ends_with(']')) => host,
        _ => h,
    }
}

/// A CIDR like "10.0.0.1/32" or "fd00::/8" (a bare address = a single host).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub bits: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Result<Cidr, String> {
        let (a, b) = match s.split_once('/') {
            Some((a, b)) => (a, Some(b)),
            None => (s, None),
        };
        let addr: IpAddr = a.trim().parse().map_err(|_| format!("bad address in '{s}'"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let bits = match b {
            Some(b) => b.trim().parse::<u8>().map_err(|_| format!("bad prefix in '{s}'"))?,
            None => max,
        };
        if bits > max {
            return Err(format!("prefix too long in '{s}'"));
        }
        Ok(Cidr { addr, bits })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canon(ip);
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                let m = if self.bits == 0 { 0 } else { u32::MAX << (32 - self.bits) };
                u32::from(n) & m == u32::from(i) & m
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => {
                let m = if self.bits == 0 { 0 } else { u128::MAX << (128 - self.bits) };
                u128::from(n) & m == u128::from(i) & m
            }
            _ => false,
        }
    }
}

/// IPv4-mapped IPv6 → IPv4 (a dual-stack socket reports those).
pub fn canon(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

impl Config {
    pub fn parse(raw: &str) -> Result<Config, String> {
        let c: Config = toml::from_str(raw).map_err(|e| format!("trunk.toml invalid: {e}"))?;
        c.validate()?;
        Ok(c)
    }

    pub fn load(path: &str) -> Result<Config, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("cannot read config {path}: {e}"))?;
        Config::parse(&raw).map_err(|e| format!("{path}: {e}"))
    }

    fn validate(&self) -> Result<(), String> {
        let o = origin_of(&self.public_url).ok_or("public_url must be an origin like https://host[:port]")?;
        if o != self.public_url.trim_end_matches('/') {
            return Err("public_url must be an origin (no path)".into());
        }
        if self.listen_http.is_empty() && self.listen_tls.is_empty() {
            return Err("set listen_http or listen_tls".into());
        }
        if !self.listen_tls.is_empty() && (self.cert_path.is_empty() || self.key_path.is_empty()) {
            return Err("listen_tls needs cert_path and key_path".into());
        }
        if self.proxy_protocol && self.listen_tls.is_empty() {
            return Err("proxy_protocol applies to listen_tls (the sni-443 hop)".into());
        }
        for c in self.trusted_proxies.iter().chain(&self.ice_owner_from) {
            Cidr::parse(c)?;
        }
        for o in &self.origins {
            if origin_of(o).as_deref() != Some(o.trim_end_matches('/')) {
                return Err(format!("origins: '{o}' is not an origin"));
            }
        }
        for n in &self.extra_names {
            if n.is_empty() || n.contains('/') || n.contains(':') {
                return Err(format!("extra_names: '{n}' must be a bare host name"));
            }
        }
        if !matches!(self.auth.region_policy.as_str(), "refresh" | "repair") {
            return Err("auth.region_policy must be \"refresh\" or \"repair\"".into());
        }
        for (k, p) in &self.oauth {
            if k.is_empty() || k.len() > 32 || !k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_') {
                return Err(format!("oauth.{k}: the id must be 1–32 of a-z 0-9 - _ (it is part of the callback URL)"));
            }
            if p.client_id.is_empty() || p.client_secret_file.is_empty() || p.client_secret_file.contains('/') || p.client_secret_file.starts_with('.') {
                return Err(format!("oauth.{k}: client_id required; client_secret_file is a name inside cred_dir"));
            }
            let kind = p.kind_of(k);
            if kind != "oidc" && kind != "github" {
                return Err(format!("oauth.{k}: kind must be \"oidc\" or \"github\""));
            }
            let iss = p.issuer_of(k);
            if iss.is_empty() {
                return Err(format!("oauth.{k}: issuer required (a generic OpenID Connect provider)"));
            }
            for u in [Some(&iss), p.authorize_url.as_ref(), p.token_url.as_ref(), p.api_url.as_ref()].into_iter().flatten() {
                if !provider_url_ok(u) {
                    return Err(format!("oauth.{k}: '{u}' must be https (plain http only on loopback)"));
                }
            }
        }
        // passkeys (§8): the RP ID must be the trunk's host or a parent of it, and of every origin
        // a passkey may be used from (so passkeys made on ljoolq. still work on ap.)
        let rp = self.rp_id();
        for o in self.passkey_origins() {
            let host = strip_port(o.split_once("://").map(|(_, h)| h).unwrap_or(&o));
            if !(host == rp || host.ends_with(&format!(".{rp}"))) {
                return Err(format!("rp_id '{rp}' does not cover the origin '{o}' (it must be that host or a parent domain of it)"));
            }
        }
        for (k, v) in [("db", &self.db), ("state_dir", &self.state_dir), ("cred_dir", &self.cred_dir), ("ctl_socket", &self.ctl_socket)] {
            if v.is_empty() {
                return Err(format!("{k} is required"));
            }
        }
        Ok(())
    }

    /// The trunk's own origin (no trailing slash).
    pub fn origin(&self) -> String {
        self.public_url.trim_end_matches('/').to_string()
    }

    /// Origins a browser write may carry: public_url, https://<each extra name>, and each of
    /// `origins` (spec §11 step 6 adds `ap.` there at switchover; its pages must be able to write).
    pub fn write_origins(&self) -> Vec<String> {
        let mut v = vec![self.origin()];
        v.extend(self.extra_names.iter().map(|n| format!("https://{n}")));
        for o in &self.origins {
            let o = o.trim_end_matches('/').to_ascii_lowercase();
            if !v.contains(&o) {
                v.push(o);
            }
        }
        v
    }

    /// The WebAuthn RP ID: `rp_id`, or the public host without its port.
    pub fn rp_id(&self) -> String {
        if !self.rp_id.trim().is_empty() {
            return self.rp_id.trim().to_ascii_lowercase();
        }
        strip_port(&self.host()).to_string()
    }

    /// Origins a passkey ceremony may come from: the same list (exact matches; no subdomain or
    /// port wildcards).
    pub fn passkey_origins(&self) -> Vec<String> {
        self.write_origins()
    }

    pub fn host(&self) -> String {
        let o = self.origin();
        o.split_once("://").map(|(_, h)| h.to_string()).unwrap_or(o)
    }

    pub fn trusted(&self) -> Vec<Cidr> {
        self.trusted_proxies.iter().filter_map(|c| Cidr::parse(c).ok()).collect()
    }

    pub fn ice_owner_cidrs(&self) -> Vec<Cidr> {
        self.ice_owner_from.iter().filter_map(|c| Cidr::parse(c).ok()).collect()
    }
}

/// "https://Host:443/x" → "https://host:443"; None when not http(s).
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{}", host.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: &str = r#"
public_url = "https://ljoolq.veraldar.org"
listen_http = "127.0.0.1:18801"
db = "/x/trunk.db"
state_dir = "/x"
cred_dir = "/x/cred"
ctl_socket = "/x/ctl.sock"
"#;

    #[test]
    fn minimal_config_parses() {
        let c = Config::parse(MIN).unwrap();
        assert_eq!(c.origin(), "https://ljoolq.veraldar.org");
        assert_eq!(c.auth.region_policy, "refresh");
        assert_eq!(c.host(), "ljoolq.veraldar.org");
    }

    #[test]
    fn unknown_keys_are_an_error() {
        assert!(Config::parse(&format!("{MIN}\nbogus = 1\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\n[auth]\nregion_policy = \"refresh\"\nbogus = 2\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\n[oauth.google]\nissuer=\"x\"\nclient_id=\"a\"\nclient_secret_file=\"g\"\nnope=1\n")).is_err());
    }

    #[test]
    fn the_contract_example_parses() {
        let raw = r#"
public_url     = "https://ljoolq.veraldar.org"
extra_names    = []
listen_http    = "0.0.0.0:8080"
listen_tls     = ""
listen_ice     = ""
proxy_protocol = false
trusted_proxies = ["10.0.0.1/32"]
db             = "/var/lib/yggdrasil-trunk/trunk.db"
state_dir      = "/var/lib/yggdrasil-trunk"
cred_dir       = "/run/trunk"
ctl_socket     = "/run/trunk/ctl.sock"
acme_webroot   = "/var/lib/yggdrasil-trunk/acme"
rp_id          = "veraldar.org"
origins        = ["https://ljoolq.veraldar.org"]
ice_owner_from = ["10.0.0.1/32"]
[auth]
region_policy = "refresh"
[oauth.google]
issuer = "https://accounts.google.com"
client_id = "x"
client_secret_file = "oauth-google"
"#;
        let c = Config::parse(raw).unwrap();
        assert!(c.trusted()[0].contains("10.0.0.1".parse().unwrap()));
        assert!(!c.trusted()[0].contains("10.0.0.2".parse().unwrap()));
        assert_eq!(c.oauth["google"].client_secret_file, "oauth-google");
    }

    #[test]
    fn oauth_presets_and_generic_providers() {
        let c = Config::parse(&format!("{MIN}\n[oauth.google]\nclient_id=\"g\"\nclient_secret_file=\"oauth-google\"\n[oauth.github]\nclient_id=\"h\"\nclient_secret_file=\"oauth-github\"\n")).unwrap();
        let (g, h) = (&c.oauth["google"], &c.oauth["github"]);
        assert_eq!((g.kind_of("google"), g.issuer_of("google").as_str(), g.display_of("google").as_str()), ("oidc", "https://accounts.google.com", "Google"));
        assert_eq!((h.kind_of("github"), h.issuer_of("github").as_str(), h.display_of("github").as_str()), ("github", "https://github.com", "GitHub"));
        // a generic provider needs its issuer; https, or plain http only on loopback (a rig's mock)
        assert!(Config::parse(&format!("{MIN}\n[oauth.acme]\nclient_id=\"a\"\nclient_secret_file=\"x\"\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\n[oauth.acme]\nissuer=\"http://idp.example\"\nclient_id=\"a\"\nclient_secret_file=\"x\"\n")).is_err());
        let m = Config::parse(&format!("{MIN}\n[oauth.mock]\nissuer=\"http://127.0.0.1:18850/\"\nclient_id=\"a\"\nclient_secret_file=\"x\"\ndisplay=\"Mock ID\"\n")).unwrap();
        assert_eq!((m.oauth["mock"].issuer_of("mock").as_str(), m.oauth["mock"].display_of("mock").as_str()), ("http://127.0.0.1:18850", "Mock ID"));
        // the id is part of the callback path; the secret is a file name inside cred_dir
        assert!(Config::parse(&format!("{MIN}\n[oauth.Bad]\nissuer=\"https://x.example\"\nclient_id=\"a\"\nclient_secret_file=\"x\"\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\n[oauth.google]\nclient_id=\"a\"\nclient_secret_file=\"../etc/x\"\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\n[oauth.google]\nclient_id=\"a\"\nclient_secret_file=\"x\"\nkind=\"saml\"\n")).is_err());
    }

    #[test]
    fn the_rp_id_must_cover_every_passkey_origin() {
        assert_eq!(Config::parse(MIN).unwrap().rp_id(), "ljoolq.veraldar.org");
        let local = MIN.replace("https://ljoolq.veraldar.org", "http://localhost:18801");
        assert_eq!(Config::parse(&local).unwrap().rp_id(), "localhost");
        let moved = format!("{MIN}\nrp_id = \"veraldar.org\"\nextra_names = [\"ap.veraldar.org\"]\norigins = [\"https://ljoolq.veraldar.org\"]\n");
        let c = Config::parse(&moved).unwrap();
        assert_eq!(c.passkey_origins(), vec!["https://ljoolq.veraldar.org", "https://ap.veraldar.org"]);
        let ap = Config::parse(&format!("{MIN}\nrp_id = \"veraldar.org\"\norigins = [\"https://ap.veraldar.org\"]\n")).unwrap();
        assert_eq!(ap.write_origins(), vec!["https://ljoolq.veraldar.org", "https://ap.veraldar.org"], "a host in origins may write too (switchover)");
        assert!(Config::parse(&format!("{MIN}\nrp_id = \"example.org\"\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\nrp_id = \"veraldar.org\"\norigins = [\"https://evil.example\"]\n")).is_err());
        assert!(Config::parse(&format!("{MIN}\nrp_id = \"ar.org\"\n")).is_err(), "a suffix that is not a parent domain");
        assert!(!provider_url_ok("https://idp.example/authorize\r\nSet-Cookie: x=1"));
        assert!(!provider_url_ok("https://idp.example/a b"));
        assert!(provider_url_ok("https://idp.example/authorize?x=1") && provider_url_ok("http://localhost:18890/a"));
        assert_eq!(strip_port("[::1]:80"), "[::1]");
        assert_eq!(strip_port("host"), "host");
    }

    #[test]
    fn cidrs() {
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains("10.9.8.7".parse().unwrap()));
        assert!(c.contains("::ffff:10.1.1.1".parse().unwrap()));
        assert!(!c.contains("11.0.0.1".parse().unwrap()));
        assert!(Cidr::parse("fd00::/8").unwrap().contains("fd12::1".parse().unwrap()));
        assert!(Cidr::parse("10.0.0.0/33").is_err());
    }
}
