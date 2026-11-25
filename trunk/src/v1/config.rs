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

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuth {
    pub issuer: String,
    pub client_id: String,
    /// a file name inside cred_dir
    pub client_secret_file: String,
    #[serde(default)]
    pub display: Option<String>,
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
            if p.client_id.is_empty() || p.client_secret_file.contains('/') {
                return Err(format!("oauth.{k}: client_id required; client_secret_file is a name inside cred_dir"));
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

    /// Origins a browser write may carry: public_url plus https://<each extra name>.
    pub fn write_origins(&self) -> Vec<String> {
        let mut v = vec![self.origin()];
        v.extend(self.extra_names.iter().map(|n| format!("https://{n}")));
        v
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
    fn cidrs() {
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains("10.9.8.7".parse().unwrap()));
        assert!(c.contains("::ffff:10.1.1.1".parse().unwrap()));
        assert!(!c.contains("11.0.0.1".parse().unwrap()));
        assert!(Cidr::parse("fd00::/8").unwrap().contains("fd12::1".parse().unwrap()));
        assert!(Cidr::parse("10.0.0.0/33").is_err());
    }
}
