//! OAuth sign-in (spec §4.1 item 2, §5.6 F1/F2, §8 "OAuth"): a generic OpenID Connect provider
//! (discovery + JWKS), with Google and GitHub presets. Authorization code flow with PKCE S256, a
//! one-use `state` (bound to the browser that started the flow by a cookie) and a `nonce`; the ID
//! token's signature is checked against the provider's JWKS (cached, fetched again on an unknown
//! `kid`), then `iss`, `aud`/`azp`, `exp`, `iat`, `nonce` and `email_verified: true`. GitHub's
//! OAuth apps have no ID token: its identity is the numeric user id and a primary, verified e-mail
//! from the API.
//!
//! Who gets in: an identity bound to the account — (issuer, sub) in `oauth_ids` — and only during
//! the claim may a new identity be bound (it creates the admin; no invites in v1). Every OAuth sign-in
//! still owes a second factor (TOTP, a recovery code or a passkey) before a device exists; the claim
//! enrols TOTP first. Refusals are generic to the browser and specific in the audit log. The client
//! secret is read from `cred_dir` when it is needed and never logged.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::audit::Entry;
use super::challenge::{self, Kind as CKind};
use super::limits::{self, Kind as LKind};
use super::{account, claim};
use crate::v1::config::{Config, OAuth as OAuthCfg};
use crate::v1::crypto::{b64u, ct_eq, random_bytes, sha256, unb64u};
use crate::v1::db::now_ms;
use crate::v1::http::{Req, Resp};
use crate::v1::server::State;

/// The browser-binding cookie: set when the flow starts, checked on the callback. `SameSite=Lax`
/// because the callback is a top-level navigation from the provider's site (a Strict cookie would
/// not come back with it).
pub const BIND_COOKIE: &str = "bifrost_oauth";
pub const BIND_PATH: &str = "/t/auth/oauth";
/// Clock skew allowed on `exp` / `iat`.
const SKEW_S: i64 = 60;
/// An unknown `kid` fetches the JWKS again at most this often (per provider).
const JWKS_MISS_EVERY_MS: i64 = 10_000;
const DISCOVERY_TTL_MS: i64 = 3_600_000;
const JWKS_TTL_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Oidc,
    Github,
}

/// A configured provider whose secret file is present.
#[derive(Debug, Clone)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub flavor: Flavor,
    pub issuer: String,
    pub client_id: String,
    pub secret_path: String,
    pub scopes: String,
    pub authorize_url: Option<String>,
    pub token_url: Option<String>,
    pub api_url: String,
}

impl Provider {
    fn from_cfg(cfg: &Config, id: &str, p: &OAuthCfg) -> Provider {
        let flavor = if p.kind_of(id) == "github" { Flavor::Github } else { Flavor::Oidc };
        Provider {
            id: id.to_string(),
            name: p.display_of(id),
            flavor,
            issuer: p.issuer_of(id),
            client_id: p.client_id.clone(),
            secret_path: format!("{}/{}", cfg.cred_dir.trim_end_matches('/'), p.client_secret_file),
            scopes: p.scopes.clone().unwrap_or_else(|| match flavor {
                Flavor::Oidc => "openid email".into(),
                Flavor::Github => "read:user user:email".into(),
            }),
            authorize_url: p.authorize_url.clone().or_else(|| (flavor == Flavor::Github).then(|| "https://github.com/login/oauth/authorize".into())),
            token_url: p.token_url.clone().or_else(|| (flavor == Flavor::Github).then(|| "https://github.com/login/oauth/access_token".into())),
            api_url: p.api_url.clone().unwrap_or_else(|| "https://api.github.com".into()).trim_end_matches('/').to_string(),
        }
    }

    /// The client secret (trimmed). Read when needed, so a rotated file needs no restart.
    fn secret(&self) -> Option<String> {
        let s = std::fs::read_to_string(&self.secret_path).ok()?;
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    fn ready(&self) -> bool {
        self.secret().is_some()
    }
}

/// Providers with their secret in place (a provider whose secret is missing has no button).
pub fn providers(st: &State) -> Vec<Provider> {
    st.cfg.oauth.iter().map(|(id, p)| Provider::from_cfg(&st.cfg, id, p)).filter(Provider::ready).collect()
}

pub fn provider(st: &State, id: &str) -> Option<Provider> {
    st.cfg.oauth.get(id).map(|p| Provider::from_cfg(&st.cfg, id, p)).filter(Provider::ready)
}

/// `providers[]` of `/t/state` and the claim ticket: `[{id, name}]`.
pub fn public_list(st: &State) -> Vec<Value> {
    providers(st).into_iter().map(|p| json!({ "id": p.id, "name": p.name })).collect()
}

/// Print, once at start, which providers are on (and which lack their secret file).
pub fn log_startup(st: &State) {
    for (id, p) in &st.cfg.oauth {
        let pr = Provider::from_cfg(&st.cfg, id, p);
        if pr.ready() {
            println!("  trunk: oauth {id} on ({}, {})", pr.name, pr.issuer);
        } else {
            eprintln!("  trunk: oauth {id} OFF — no secret in {} (the button stays hidden)", pr.secret_path);
        }
    }
}

// ---- caches -----------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Discovery {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    pub basic_auth: bool,
}

#[derive(Default)]
struct ProviderCache {
    discovery: Option<(i64, Discovery)>,
    jwks: Option<(i64, Vec<Value>)>,
    last_miss_fetch: i64,
    jwks_fetches: u64,
}

#[derive(Default)]
pub struct Cache {
    inner: Mutex<HashMap<String, ProviderCache>>,
}

impl Cache {
    /// JWKS fetches so far for a provider (tests: the cache is used, a new kid fetches again).
    pub fn jwks_fetches(&self, id: &str) -> u64 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).get(id).map(|c| c.jwks_fetches).unwrap_or(0)
    }
}

// ---- HTTP (blocking ureq, run on the blocking pool) ----------------------------------------------

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).redirects(0).user_agent("bifrost-trunk/1 (oauth)").build()
}

/// GET a JSON document. Errors name the URL and status, never a body or a secret.
fn get_json(url: &str, bearer: Option<&str>) -> Result<Value, String> {
    let mut r = agent().get(url).set("Accept", "application/json");
    if let Some(t) = bearer {
        r = r.set("Authorization", &format!("Bearer {t}"));
    }
    match r.call() {
        Ok(resp) => resp.into_json::<Value>().map_err(|_| format!("{url}: not JSON")),
        Err(ureq::Error::Status(code, _)) => Err(format!("{url}: HTTP {code}")),
        Err(e) => Err(format!("{url}: {}", e.kind())),
    }
}

fn form_enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn post_form(url: &str, fields: &[(&str, &str)], basic: Option<(&str, &str)>) -> Result<Value, String> {
    let mut r = agent().post(url).set("Accept", "application/json");
    if let Some((id, secret)) = basic {
        let raw = format!("{}:{}", form_enc(id), form_enc(secret));
        r = r.set("Authorization", &format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw)));
    }
    match r.send_form(fields) {
        Ok(resp) => resp.into_json::<Value>().map_err(|_| format!("{url}: not JSON")),
        Err(ureq::Error::Status(code, resp)) => {
            // the provider's error code is safe to log (no secret in it); its description may not be
            let e = resp.into_json::<Value>().ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
            Err(format!("{url}: HTTP {code} {}", e.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect::<String>()))
        }
        Err(e) => Err(format!("{url}: {}", e.kind())),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("blocking task: {e}"))
}

async fn discovery(st: &Arc<State>, p: &Provider) -> Result<Discovery, String> {
    if p.flavor == Flavor::Github {
        return Ok(Discovery {
            authorization_endpoint: p.authorize_url.clone().unwrap_or_default(),
            token_endpoint: p.token_url.clone().unwrap_or_default(),
            jwks_uri: String::new(),
            basic_auth: false,
        });
    }
    let now = now_ms();
    if let Some((at, d)) = st.idp.oauth.inner.lock().unwrap_or_else(|e| e.into_inner()).get(&p.id).and_then(|c| c.discovery.clone()) {
        if now - at < DISCOVERY_TTL_MS {
            return Ok(d);
        }
    }
    let url = format!("{}/.well-known/openid-configuration", p.issuer);
    let doc = blocking(move || get_json(&url, None)).await??;
    let s = |k: &str| doc.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if s("issuer").trim_end_matches('/') != p.issuer {
        return Err(format!("discovery: issuer '{}' is not the configured '{}'", s("issuer"), p.issuer));
    }
    let methods: Vec<String> = doc
        .get("token_endpoint_auth_methods_supported")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let d = Discovery {
        authorization_endpoint: p.authorize_url.clone().unwrap_or_else(|| s("authorization_endpoint")),
        token_endpoint: p.token_url.clone().unwrap_or_else(|| s("token_endpoint")),
        jwks_uri: s("jwks_uri"),
        basic_auth: methods.is_empty() || methods.iter().any(|m| m == "client_secret_basic"),
    };
    for u in [&d.authorization_endpoint, &d.token_endpoint, &d.jwks_uri] {
        if !crate::v1::config::provider_url_ok(u) {
            return Err(format!("discovery: endpoint '{u}' must be https"));
        }
    }
    st.idp.oauth.inner.lock().unwrap_or_else(|e| e.into_inner()).entry(p.id.clone()).or_default().discovery = Some((now, d.clone()));
    Ok(d)
}

/// The JWKS, from the cache unless `refetch` (an unknown kid; rate-limited per provider).
async fn jwks(st: &Arc<State>, p: &Provider, d: &Discovery, refetch: bool) -> Result<Vec<Value>, String> {
    let now = now_ms();
    {
        let mut g = st.idp.oauth.inner.lock().unwrap_or_else(|e| e.into_inner());
        let c = g.entry(p.id.clone()).or_default();
        if let Some((at, keys)) = &c.jwks {
            let fresh = now - *at < JWKS_TTL_MS;
            if fresh && (!refetch || now - c.last_miss_fetch < JWKS_MISS_EVERY_MS) {
                return Ok(keys.clone());
            }
        }
        if refetch {
            c.last_miss_fetch = now;
        }
        c.jwks_fetches += 1;
    }
    let url = d.jwks_uri.clone();
    let doc = blocking(move || get_json(&url, None)).await??;
    let keys = doc.get("keys").and_then(Value::as_array).cloned().ok_or("jwks: no keys")?;
    st.idp.oauth.inner.lock().unwrap_or_else(|e| e.into_inner()).entry(p.id.clone()).or_default().jwks = Some((now, keys.clone()));
    Ok(keys)
}

// ---- the ID token ----------------------------------------------------------------------------------

/// Why a sign-in was refused (the audit's `why`; the browser only sees a generic message).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    State,
    Denied,
    Exchange,
    Malformed,
    Alg,
    Kid,
    Signature,
    Iss,
    Aud,
    Exp,
    Nonce,
    EmailUnverified,
    UnknownIdentity,
    Disabled,
    Claim,
    Lockdown,
    Provider,
}

impl Fail {
    pub fn as_str(self) -> &'static str {
        match self {
            Fail::State => "state",
            Fail::Denied => "denied",
            Fail::Exchange => "exchange",
            Fail::Malformed => "malformed",
            Fail::Alg => "alg",
            Fail::Kid => "kid",
            Fail::Signature => "signature",
            Fail::Iss => "iss",
            Fail::Aud => "aud",
            Fail::Exp => "exp",
            Fail::Nonce => "nonce",
            Fail::EmailUnverified => "email_unverified",
            Fail::UnknownIdentity => "unknown_identity",
            Fail::Disabled => "disabled",
            Fail::Claim => "claim",
            Fail::Lockdown => "lockdown",
            Fail::Provider => "provider",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub issuer: String,
    pub subject: String,
    pub email: String,
}

pub struct Expect<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: &'a str,
    pub now_s: i64,
}

fn strip_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len().saturating_sub(1));
    &b[i..]
}

fn pad32(b: &[u8]) -> Option<[u8; 32]> {
    let b = strip_zeros(b);
    if b.len() > 32 {
        return None;
    }
    let mut o = [0u8; 32];
    o[32 - b.len()..].copy_from_slice(b);
    Some(o)
}

/// Check a JWS signature with one JWK (RS256 or ES256; nothing else is accepted).
fn verify_sig(alg: &str, jwk: &Value, msg: &[u8], sig: &[u8]) -> bool {
    let g = |k: &str| jwk.get(k).and_then(Value::as_str).and_then(unb64u);
    if let Some(a) = jwk.get("alg").and_then(Value::as_str) {
        if a != alg {
            return false;
        }
    }
    if jwk.get("use").and_then(Value::as_str).is_some_and(|u| u != "sig") {
        return false;
    }
    match (alg, jwk.get("kty").and_then(Value::as_str)) {
        ("RS256", Some("RSA")) => {
            let (Some(n), Some(e)) = (g("n"), g("e")) else { return false };
            let pk = ring::signature::RsaPublicKeyComponents { n: strip_zeros(&n), e: strip_zeros(&e) };
            pk.verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, msg, sig).is_ok()
        }
        ("ES256", Some("EC")) => {
            if jwk.get("crv").and_then(Value::as_str) != Some("P-256") || sig.len() != 64 {
                return false;
            }
            let (Some(x), Some(y)) = (g("x").as_deref().and_then(pad32), g("y").as_deref().and_then(pad32)) else { return false };
            let mut point = vec![4u8];
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, point).verify(msg, sig).is_ok()
        }
        _ => false,
    }
}

/// The `kid` an ID token names (to decide whether the JWKS must be fetched again).
pub fn token_kid(token: &str) -> Option<String> {
    let h = token.split('.').next()?;
    let v: Value = serde_json::from_slice(&unb64u(h)?).ok()?;
    v.get("kid").and_then(Value::as_str).map(str::to_string)
}

/// Verify an ID token against `keys`. Order: shape, alg, kid, signature, then the claims.
pub fn verify_id_token(token: &str, keys: &[Value], ex: &Expect) -> Result<Identity, Fail> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || token.len() > 16_384 {
        return Err(Fail::Malformed);
    }
    let header: Value = unb64u(parts[0]).and_then(|b| serde_json::from_slice(&b).ok()).ok_or(Fail::Malformed)?;
    let claims: Value = unb64u(parts[1]).and_then(|b| serde_json::from_slice(&b).ok()).ok_or(Fail::Malformed)?;
    let sig = unb64u(parts[2]).ok_or(Fail::Malformed)?;
    let alg = header.get("alg").and_then(Value::as_str).unwrap_or("");
    if alg != "RS256" && alg != "ES256" {
        return Err(Fail::Alg);
    }
    if header.get("crit").is_some() {
        return Err(Fail::Alg);
    }
    let kid = header.get("kid").and_then(Value::as_str);
    let candidates: Vec<&Value> = keys.iter().filter(|k| kid.is_none() || k.get("kid").and_then(Value::as_str) == kid).collect();
    if candidates.is_empty() {
        return Err(Fail::Kid);
    }
    let msg = format!("{}.{}", parts[0], parts[1]);
    if !candidates.iter().any(|k| verify_sig(alg, k, msg.as_bytes(), &sig)) {
        return Err(Fail::Signature);
    }
    let s = |k: &str| claims.get(k).and_then(Value::as_str);
    // Google documents both forms of its issuer
    let iss = s("iss").unwrap_or("");
    let iss_ok = iss == ex.issuer || (ex.issuer == "https://accounts.google.com" && iss == "accounts.google.com");
    if !iss_ok {
        return Err(Fail::Iss);
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(a)) => a == ex.client_id,
        Some(Value::Array(a)) => {
            a.iter().any(|x| x.as_str() == Some(ex.client_id)) && (a.len() == 1 || s("azp") == Some(ex.client_id))
        }
        _ => false,
    };
    if !aud_ok || s("azp").is_some_and(|azp| azp != ex.client_id) {
        return Err(Fail::Aud);
    }
    let exp = claims.get("exp").and_then(Value::as_i64).ok_or(Fail::Exp)?;
    if exp + SKEW_S <= ex.now_s {
        return Err(Fail::Exp);
    }
    if claims.get("iat").and_then(Value::as_i64).is_some_and(|iat| iat > ex.now_s + SKEW_S) {
        return Err(Fail::Exp);
    }
    if !s("nonce").is_some_and(|n| !ex.nonce.is_empty() && ct_eq(n.as_bytes(), ex.nonce.as_bytes())) {
        return Err(Fail::Nonce);
    }
    let verified = matches!(claims.get("email_verified"), Some(Value::Bool(true))) || s("email_verified") == Some("true");
    let email = s("email").and_then(account::norm_email);
    let (true, Some(email)) = (verified, email) else { return Err(Fail::EmailUnverified) };
    let sub = s("sub").filter(|x| !x.is_empty() && x.len() <= 255).ok_or(Fail::Malformed)?;
    Ok(Identity { issuer: ex.issuer.to_string(), subject: sub.to_string(), email })
}

/// RFC 7636 S256.
pub fn pkce_challenge(verifier: &str) -> String {
    b64u(&sha256(verifier.as_bytes()))
}

// ---- start ---------------------------------------------------------------------------------------

/// The origin the browser is on (public_url or an extra name), from its Host header.
fn request_origin(st: &State, req: &Req) -> String {
    let host = req.header("host").unwrap_or("").trim().to_ascii_lowercase();
    st.cfg.write_origins().into_iter().find(|o| o.split_once("://").map(|(_, h)| h) == Some(host.as_str())).unwrap_or_else(|| st.cfg.origin())
}

/// A `next` that stays on this origin (the login page's rule).
pub fn safe_next(n: &str) -> Option<String> {
    let ok = n.starts_with('/') && !n.starts_with("//") && !n.starts_with("/t/") && !n.contains(['\\', '\r', '\n', '#']) && n.len() <= 256;
    ok.then(|| n.to_string())
}

fn busy() -> Resp {
    Resp::json(429, &json!({ "error": "too many sign-ins in flight from your network — wait a minute", "why": "busy", "retry_after": 60 })).header("Retry-After", "60")
}

/// Start a flow: `intent` "login" (claimed trunk) or "claim" (an approved claim ticket).
/// Ok = (the provider URL to send the browser to, the binding cookie's value).
pub async fn start(st: &Arc<State>, pid: &str, intent: &str, ticket: Option<&str>, next: Option<&str>, req: &Req, ip: IpAddr) -> Result<(String, String), Resp> {
    let Some(p) = provider(st, pid) else { return Err(Resp::json(404, &json!({ "error": "no such sign-in provider", "why": "provider" }))) };
    if let Some(s) = limits::locked(&st.db, &limits::net_key(ip), now_ms()) {
        return Err(Resp::json(429, &json!({ "error": "too many attempts — wait and try again", "why": "locked", "retry_after": s })).header("Retry-After", &s.to_string()));
    }
    let ticket = match intent {
        "login" => {
            if !st.claimed() {
                return Err(Resp::json(409, &json!({ "error": "this trunk is not claimed yet", "why": "unclaimed" })));
            }
            if st.lockdown() {
                return Err(Resp::json(403, &json!({ "error": "sign-in is locked down — `trunk-ctl unlock` on the server", "why": "lockdown" })));
            }
            None
        }
        "claim" => {
            let t = ticket.unwrap_or("");
            match claim::check_ticket(st, t) {
                Ok(s) if s == "approved" => Some(t.to_string()),
                Ok(_) => return Err(Resp::json(409, &json!({ "error": "approve the claim first", "why": "state" }))),
                Err(e) => return Err(e.resp()),
            }
        }
        _ => return Err(Resp::json(400, &json!({ "error": "intent must be login or claim", "why": "intent" }))),
    };
    let d = discovery(st, &p).await.map_err(|e| {
        eprintln!("  trunk: oauth {}: {e}", p.id);
        Resp::json(502, &json!({ "error": "the sign-in provider is not answering — try again later", "why": "provider" }))
    })?;
    let verifier = b64u(&random_bytes::<32>());
    let nonce = b64u(&random_bytes::<24>());
    let bind = b64u(&random_bytes::<24>());
    let redirect_uri = format!("{}/t/auth/oauth/{}/callback", request_origin(st, req), p.id);
    let data = json!({
        "provider": p.id, "intent": intent, "verifier": verifier, "nonce": nonce,
        "bind": b64u(&sha256(bind.as_bytes())), "redirect_uri": redirect_uri, "ticket": ticket,
        "next": next.and_then(safe_next),
    });
    let state = match challenge::put(st, CKind::OAuth, None, None, ip, st.idp.t.oauth_ttl_ms, &data) {
        Ok(h) => h,
        Err(challenge::PutErr::Busy) => return Err(busy()),
        Err(challenge::PutErr::Db(e)) => return Err(Resp::json(500, &json!({ "error": e }))),
    };
    let mut q = vec![
        ("response_type", "code".to_string()),
        ("client_id", p.client_id.clone()),
        ("redirect_uri", redirect_uri),
        ("scope", p.scopes.clone()),
        ("state", state),
        ("code_challenge", pkce_challenge(&verifier)),
        ("code_challenge_method", "S256".into()),
    ];
    if p.flavor == Flavor::Oidc {
        q.push(("nonce", nonce));
    }
    let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", form_enc(v))).collect();
    let sep = if d.authorization_endpoint.contains('?') { '&' } else { '?' };
    Ok((format!("{}{sep}{}", d.authorization_endpoint, qs.join("&")), bind))
}

pub fn bind_cookie(r: Resp, value: &str, max_age: i64) -> Resp {
    let v = format!("{BIND_COOKIE}={value}; Path={BIND_PATH}; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax");
    r.header("Set-Cookie", &v)
}

// ---- callback ----------------------------------------------------------------------------------------

struct Flow {
    provider: String,
    intent: String,
    verifier: String,
    nonce: String,
    redirect_uri: String,
    ticket: Option<String>,
    next: Option<String>,
}

/// Exchange the code and find out who it is (network calls on the blocking pool).
async fn identify(st: &Arc<State>, p: &Provider, f: &Flow, code: &str) -> Result<Identity, (Fail, String)> {
    let d = discovery(st, p).await.map_err(|e| (Fail::Provider, e))?;
    let secret = p.secret().ok_or((Fail::Provider, "client secret file missing".to_string()))?;
    let (url, id, verifier, redirect, code) = (d.token_endpoint.clone(), p.client_id.clone(), f.verifier.clone(), f.redirect_uri.clone(), code.to_string());
    let basic = d.basic_auth;
    let tok = blocking(move || {
        let mut fields = vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect.as_str()), ("code_verifier", verifier.as_str())];
        if basic {
            post_form(&url, &fields, Some((&id, &secret)))
        } else {
            fields.push(("client_id", id.as_str()));
            fields.push(("client_secret", secret.as_str()));
            post_form(&url, &fields, None)
        }
    })
    .await
    .map_err(|e| (Fail::Exchange, e))?
    .map_err(|e| (Fail::Exchange, e))?;
    match p.flavor {
        Flavor::Oidc => {
            let idt = tok.get("id_token").and_then(Value::as_str).ok_or((Fail::Exchange, "no id_token in the token response".to_string()))?.to_string();
            let ex = Expect { issuer: &p.issuer, client_id: &p.client_id, nonce: &f.nonce, now_s: now_ms() / 1000 };
            let keys = jwks(st, p, &d, false).await.map_err(|e| (Fail::Provider, e))?;
            match verify_id_token(&idt, &keys, &ex) {
                Err(Fail::Kid) => {
                    // a key the cache has not seen yet (the provider rotated): fetch once more
                    let keys = jwks(st, p, &d, true).await.map_err(|e| (Fail::Provider, e))?;
                    verify_id_token(&idt, &keys, &ex).map_err(|w| (w, String::new()))
                }
                r => r.map_err(|w| (w, String::new())),
            }
        }
        Flavor::Github => {
            let at = tok.get("access_token").and_then(Value::as_str).ok_or((Fail::Exchange, "no access_token in the token response".to_string()))?.to_string();
            let api = p.api_url.clone();
            let (user, emails) = blocking(move || (get_json(&format!("{api}/user"), Some(&at)), get_json(&format!("{api}/user/emails"), Some(&at))))
                .await
                .map_err(|e| (Fail::Exchange, e))?;
            let user = user.map_err(|e| (Fail::Exchange, e))?;
            let emails = emails.map_err(|e| (Fail::Exchange, e))?;
            let sub = match user.get("id") {
                Some(Value::Number(n)) => n.to_string(),
                _ => return Err((Fail::Malformed, "no user id".into())),
            };
            let email = emails
                .as_array()
                .and_then(|a| {
                    a.iter().find(|e| e.get("primary").and_then(Value::as_bool) == Some(true) && e.get("verified").and_then(Value::as_bool) == Some(true))
                })
                .and_then(|e| e.get("email").and_then(Value::as_str))
                .and_then(account::norm_email)
                .ok_or((Fail::EmailUnverified, String::new()))?;
            Ok(Identity { issuer: p.issuer.clone(), subject: sub, email })
        }
    }
}

fn fail_redirect(ticket: Option<&str>) -> Resp {
    match ticket {
        Some(t) => Resp::redirect(&format!("/claim#t={t}&e=oauth")),
        None => Resp::redirect("/login#e=oauth"),
    }
}

fn refuse(st: &State, ip: IpAddr, provider: &str, intent: &str, why: Fail, note: &str, ticket: Option<&str>) -> Resp {
    if !note.is_empty() {
        eprintln!("  trunk: oauth {provider}: refused ({}): {note}", why.as_str());
    }
    if why != Fail::Denied {
        if let Some(s) = limits::fail(&st.db, &limits::net_key(ip), LKind::Net, &st.idp.t, now_ms()) {
            super::audit(st, Entry::new("lockout.net").ip(ip).detail(json!({ "seconds": s })));
        }
    }
    super::audit(st, Entry::new("auth.oauth_fail").ip(ip).detail(json!({ "provider": provider, "intent": intent, "why": why.as_str() })));
    bind_cookie(fail_redirect(ticket), "", 0)
}

/// GET /t/auth/oauth/:p/callback?code&state (or ?error&state).
pub async fn callback(st: &Arc<State>, pid: &str, req: &Req, ip: IpAddr) -> Resp {
    let state = req.query("state").unwrap_or_default();
    let Some(t) = challenge::take(st, &state, CKind::OAuth) else {
        return refuse(st, ip, pid, "?", Fail::State, "", None);
    };
    let d = &t.data;
    let g = |k: &str| d.get(k).and_then(Value::as_str).map(str::to_string);
    let f = Flow {
        provider: g("provider").unwrap_or_default(),
        intent: g("intent").unwrap_or_default(),
        verifier: g("verifier").unwrap_or_default(),
        nonce: g("nonce").unwrap_or_default(),
        redirect_uri: g("redirect_uri").unwrap_or_default(),
        ticket: g("ticket"),
        next: g("next"),
    };
    let tk = f.ticket.as_deref();
    // the flow must come back to the provider it went to, in the browser that started it
    let bind = req.cookie(BIND_COOKIE).unwrap_or_default();
    let bind_ok = !bind.is_empty() && g("bind").is_some_and(|h| ct_eq(h.as_bytes(), b64u(&sha256(bind.as_bytes())).as_bytes()));
    if f.provider != pid || !bind_ok {
        return refuse(st, ip, pid, &f.intent, Fail::State, "", tk);
    }
    if req.query("error").is_some() {
        return refuse(st, ip, pid, &f.intent, Fail::Denied, "", tk);
    }
    let Some(p) = provider(st, pid) else { return refuse(st, ip, pid, &f.intent, Fail::Provider, "provider no longer configured", tk) };
    let code = req.query("code").unwrap_or_default();
    if code.is_empty() || code.len() > 2048 {
        return refuse(st, ip, pid, &f.intent, Fail::Malformed, "no code", tk);
    }
    let who = match identify(st, &p, &f, &code).await {
        Ok(i) => i,
        Err((why, note)) => return refuse(st, ip, pid, &f.intent, why, &note, tk),
    };
    match f.intent.as_str() {
        "login" => login_with(st, &p, &f, &who, ip),
        "claim" => claim_with(st, &p, &f, &who, ip),
        _ => refuse(st, ip, pid, &f.intent, Fail::State, "", None),
    }
}

/// A known identity: the first factor passed; the second is owed on /login (#mfa=).
fn login_with(st: &State, p: &Provider, f: &Flow, who: &Identity, ip: IpAddr) -> Resp {
    if st.lockdown() {
        return refuse(st, ip, &p.id, "login", Fail::Lockdown, "", None);
    }
    let acc: Option<(String, String)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT a.id, a.status FROM oauth_ids o JOIN accounts a ON a.id = o.account_id WHERE o.issuer = ?1 AND o.subject = ?2",
                params![who.issuer, who.subject],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((account, status)) = acc else { return refuse(st, ip, &p.id, "login", Fail::UnknownIdentity, "", None) };
    if status != "active" {
        return refuse(st, ip, &p.id, "login", Fail::Disabled, "", None);
    }
    let ticket = account::new_mfa_ticket_via(st, &account, "oauth", Some(&p.id));
    super::audit(st, Entry::new("auth.oauth").account(&account).ip(ip).detail(json!({ "provider": p.id, "intent": "login", "owed": "second factor" })));
    let next = f.next.as_deref().map(|n| format!("?next={}", crate::v1::shell::url_enc(n))).unwrap_or_default();
    bind_cookie(Resp::redirect(&format!("/login{next}#mfa={ticket}&via={}", p.id)), "", 0)
}

/// The claim: bind this identity to a new admin account (e-mail from the provider, no password)
/// and leave a TOTP enrolment pending — the claim completes only on its confirm (mandatory 2FA).
fn claim_with(st: &State, p: &Provider, f: &Flow, who: &Identity, ip: IpAddr) -> Resp {
    let ticket = f.ticket.clone().unwrap_or_default();
    match claim::check_ticket(st, &ticket) {
        Ok(s) if s == "approved" => {}
        _ => return refuse(st, ip, &p.id, "claim", Fail::Claim, "the claim ticket is gone", None),
    }
    let id = match account::create_oauth_admin(st, &who.email, &who.issuer, &who.subject) {
        Ok(id) => id,
        Err(e) => return refuse(st, ip, &p.id, "claim", Fail::Claim, &e, Some(&ticket)),
    };
    super::audit(st, Entry::new("account.create").account(&id).ip(ip).target("account", &id).detail(json!({ "role": "admin", "via": "oauth", "provider": p.id })));
    super::audit(st, Entry::new("oauth.link").account(&id).ip(ip).target("account", &id).detail(json!({ "provider": p.id, "issuer": who.issuer })));
    bind_cookie(Resp::redirect(&format!("/claim#t={ticket}&via={}", p.id)), "", 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_FIXED_SIGNING};

    fn es256_key() -> (EcdsaKeyPair, Value) {
        let rng = SystemRandom::new();
        let pk8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pk8.as_ref(), &rng).unwrap();
        let p = kp.public_key().as_ref();
        let jwk = json!({ "kty": "EC", "crv": "P-256", "kid": "ec1", "use": "sig", "alg": "ES256", "x": b64u(&p[1..33]), "y": b64u(&p[33..65]) });
        (kp, jwk)
    }

    fn sign(kp: &EcdsaKeyPair, header: &Value, claims: &Value) -> String {
        let h = b64u(header.to_string().as_bytes());
        let c = b64u(claims.to_string().as_bytes());
        let msg = format!("{h}.{c}");
        let sig = kp.sign(&SystemRandom::new(), msg.as_bytes()).unwrap();
        format!("{msg}.{}", b64u(sig.as_ref()))
    }

    fn good_claims(now: i64) -> Value {
        json!({ "iss": "https://idp.example", "aud": "client-1", "sub": "user-42", "email": "Owner@Example.org", "email_verified": true,
                "nonce": "n0nce", "iat": now, "exp": now + 300 })
    }

    fn ex(now: i64) -> Expect<'static> {
        Expect { issuer: "https://idp.example", client_id: "client-1", nonce: "n0nce", now_s: now }
    }

    #[test]
    fn a_good_es256_id_token_verifies() {
        let (kp, jwk) = es256_key();
        let now = 1_764_000_000;
        let t = sign(&kp, &json!({ "alg": "ES256", "kid": "ec1", "typ": "JWT" }), &good_claims(now));
        let id = verify_id_token(&t, &[jwk], &ex(now)).unwrap();
        assert_eq!(id, Identity { issuer: "https://idp.example".into(), subject: "user-42".into(), email: "owner@example.org".into() });
    }

    #[test]
    fn every_check_refuses_its_own_fault() {
        let (kp, jwk) = es256_key();
        let (other, _) = es256_key();
        let now = 1_764_000_000;
        let keys = [jwk.clone()];
        let h = json!({ "alg": "ES256", "kid": "ec1" });
        let with = |k: &str, v: Value| {
            let mut c = good_claims(now);
            c[k] = v;
            c
        };
        let cases: Vec<(String, Fail)> = vec![
            (sign(&other, &h, &good_claims(now)), Fail::Signature),
            (sign(&kp, &json!({ "alg": "ES256", "kid": "nope" }), &good_claims(now)), Fail::Kid),
            (sign(&kp, &json!({ "alg": "HS256", "kid": "ec1" }), &good_claims(now)), Fail::Alg),
            (sign(&kp, &json!({ "alg": "none" }), &good_claims(now)), Fail::Alg),
            (sign(&kp, &h, &with("iss", json!("https://evil.example"))), Fail::Iss),
            (sign(&kp, &h, &with("aud", json!("client-2"))), Fail::Aud),
            (sign(&kp, &h, &with("aud", json!(["client-1", "client-2"]))), Fail::Aud),
            (sign(&kp, &h, &with("azp", json!("client-2"))), Fail::Aud),
            (sign(&kp, &h, &with("exp", json!(now - SKEW_S - 1))), Fail::Exp),
            (sign(&kp, &h, &with("iat", json!(now + 3600))), Fail::Exp),
            (sign(&kp, &h, &with("nonce", json!("other"))), Fail::Nonce),
            (sign(&kp, &h, &with("email_verified", json!(false))), Fail::EmailUnverified),
            (sign(&kp, &h, &with("email_verified", Value::Null)), Fail::EmailUnverified),
            (sign(&kp, &h, &with("email", json!("not an email"))), Fail::EmailUnverified),
            ("a.b".into(), Fail::Malformed),
        ];
        for (tok, want) in cases {
            assert_eq!(verify_id_token(&tok, &keys, &ex(now)).err(), Some(want), "{want:?}");
        }
        // a token signed right but cut and pasted onto other claims fails the signature
        let good = sign(&kp, &h, &good_claims(now));
        let forged_claims = b64u(with("sub", json!("someone-else")).to_string().as_bytes());
        let p: Vec<&str> = good.split('.').collect();
        assert_eq!(verify_id_token(&format!("{}.{forged_claims}.{}", p[0], p[2]), &keys, &ex(now)).err(), Some(Fail::Signature));
        // a key published for another alg is not used
        let mut rsa_labeled = jwk;
        rsa_labeled["alg"] = json!("RS256");
        assert_eq!(verify_id_token(&good, &[rsa_labeled], &ex(now)).err(), Some(Fail::Signature));
        // google's bare issuer form
        let g = Expect { issuer: "https://accounts.google.com", ..ex(now) };
        let gt = sign(&kp, &h, &with("iss", json!("accounts.google.com")));
        assert!(verify_id_token(&gt, &keys, &g).is_ok());
    }

    #[test]
    fn rs256_with_a_known_key() {
        // RFC 7515 A.2: an RS256 JWS and its key (the JWS is not an ID token, so only the signature is checked)
        let jwk = json!({ "kty": "RSA",
            "n": "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
            "e": "AQAB" });
        let tok = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw";
        let p: Vec<&str> = tok.split('.').collect();
        let msg = format!("{}.{}", p[0], p[1]);
        let sig = unb64u(p[2]).unwrap();
        assert!(verify_sig("RS256", &jwk, msg.as_bytes(), &sig));
        let mut bad = sig.clone();
        bad[10] ^= 1;
        assert!(!verify_sig("RS256", &jwk, msg.as_bytes(), &bad));
        assert!(!verify_sig("ES256", &jwk, msg.as_bytes(), &sig));
    }

    #[test]
    fn pkce_s256_matches_rfc_7636() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn next_paths_stay_on_this_origin() {
        assert_eq!(safe_next("/devices").as_deref(), Some("/devices"));
        for bad in ["//evil.example", "https://evil.example", "/t/auth/refresh", "/a\\b", "x", "/a#b"] {
            assert!(safe_next(bad).is_none(), "{bad}");
        }
    }
}
