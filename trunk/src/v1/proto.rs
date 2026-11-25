//! Proto 2 on `WS /t/root` (CONTRACTS.md C4) — shared by the v1 trunk and the root's bridge.
//!
//! Websocket binary frames, one mux message per frame, today's layout (ap.rs):
//!   `[kind u8][stream u32 BE][payload]`
//! Kinds kept from v0.9: OPEN=1 (`"<client ip>\n" + request head`), DATA=2, CLOSE=3, OPEN_RAW=4
//! (`"<client ip>\n<forward name>"`). New: CTRL=16 (stream 0, one JSON object), WG=17 (stream 0,
//! a WireGuard relay frame `[n][addr][dgram]`, wg.rs).
//!
//! Handshake (the first CTRL frames, before any mux traffic):
//!   1. trunk → root `{"t":"hello","proto":2,"trunk_id","trunk_key","nonce"}`
//!   2. root → trunk `{"t":"auth","proto":2,"root_id","nonce","sig"}` (root key over
//!      `"ygg-trunk-v1/root-auth\0" trunk_id "\0" trunk.nonce "\0" root.nonce`)
//!   3. trunk → root `{"t":"welcome","sig","root","directory","keys","kill_epoch","deny"}` (trunk key
//!      over `"ygg-trunk-v1/trunk-auth\0" root_id "\0" root.nonce "\0" trunk.nonce`)
//!
//! Every control message that carries authority (`directory`, `keys`, `revoke`, `kill`,
//! `root.revoked`) has `sig` = Ed25519(trunk key) over the RFC 8785 canonical JSON of the message
//! without `sig`. The directory object itself is signed the same way (its own `sig`), so a copy in
//! `trunk-state.json` stands on its own (`bifrost-net wg` verifies it).
//!
//! This file is pure (no I/O, no runtime): it compiles in every build, the root build included.

use base64::Engine as _;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{self, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const PROTO: u64 = 2;
pub const OPEN: u8 = 1;
pub const DATA: u8 = 2;
pub const CLOSE: u8 = 3;
pub const OPEN_RAW: u8 = 4;
pub const CTRL: u8 = 16;
pub const WG: u8 = 17;
/// The upgrade header a proto-2 bridge sends with `GET /t/root` (a v0.9 bridge sends none → 426).
pub const PROTO_HEADER: &str = "x-ygg-proto";
/// `/t/root`'s websocket subprotocol word (informational; the header above decides).
pub const ROOT_AUTH_CTX: &str = "ygg-trunk-v1/root-auth";
pub const TRUNK_AUTH_CTX: &str = "ygg-trunk-v1/trunk-auth";
/// The ICE route lifetime a root asks for, and how often it renews (spec §5.7).
pub const ICE_TTL_S: u64 = 120;
pub const ICE_RENEW_S: u64 = 60;

/* ------------------------------------------------------------------ b64url, random */

const B64U: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn b64u(b: &[u8]) -> String {
    B64U.encode(b)
}

pub fn unb64u(s: &str) -> Option<Vec<u8>> {
    B64U.decode(s.trim().as_bytes()).ok()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    SystemRandom::new().fill(&mut b).expect("system random");
    b
}

/// A fresh handshake nonce (32 B, b64url).
pub fn nonce() -> String {
    b64u(&random_bytes::<32>())
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Constant-time equality (length first, then every byte; no early exit).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/* ------------------------------------------------------------------ frames */

pub fn mux(kind: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(5 + payload.len());
    m.push(kind);
    m.extend_from_slice(&id.to_be_bytes());
    m.extend_from_slice(payload);
    m
}

pub fn unmux(m: &[u8]) -> Option<(u8, u32, &[u8])> {
    let id = u32::from_be_bytes(m.get(1..5)?.try_into().ok()?);
    Some((*m.first()?, id, &m[5..]))
}

/// One CTRL frame (stream 0) carrying `msg`.
pub fn ctrl(msg: &Value) -> Vec<u8> {
    mux(CTRL, 0, msg.to_string().as_bytes())
}

/// The JSON object of a CTRL payload (None = not an object, or too big: 1 MiB).
pub fn parse_ctrl(payload: &[u8]) -> Option<Value> {
    if payload.len() > 1 << 20 {
        return None;
    }
    serde_json::from_slice::<Value>(payload).ok().filter(Value::is_object)
}

/* ------------------------------------------------------------------ RFC 8785 JCS */

/// The canonical JSON of `v` (RFC 8785): no whitespace, object members sorted by the UTF-16 code
/// units of their names, strings with the minimal JSON escapes, numbers as ECMAScript prints them.
pub fn jcs(v: &Value) -> String {
    let mut out = String::new();
    jcs_into(v, &mut out);
    out
}

fn jcs_into(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else {
                out.push_str(&es_number(n.as_f64().unwrap_or(0.0)));
            }
        }
        // serde_json escapes exactly `"`, `\` and U+0000–U+001F (\b \f \n \r \t short, the rest
        // \u00xx lowercase): the JCS rule
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                jcs_into(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                jcs_into(&o[k], out);
            }
            out.push('}');
        }
    }
}

/// ECMAScript Number::toString for a finite double (JCS §3.2.2.3).
fn es_number(x: f64) -> String {
    if x == 0.0 || !x.is_finite() {
        return "0".into();
    }
    let neg = x < 0.0;
    // shortest round-trip digits (Rust's Display), then ECMAScript's layout of them
    let plain = format!("{}", x.abs());
    let (ip, fp) = plain.split_once('.').unwrap_or((plain.as_str(), ""));
    let all = format!("{ip}{fp}");
    let lead = all.len() - all.trim_start_matches('0').len();
    let digits = all.trim_start_matches('0').trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i64;
    let n = ip.len() as i64 - lead as i64;
    let s = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    if neg { format!("-{s}") } else { s }
}

/* ------------------------------------------------------------------ Ed25519 */

/// An Ed25519 signing key (the trunk key, or a root key) from its 32-byte seed.
pub struct SignKey {
    pair: Ed25519KeyPair,
    seed: [u8; 32],
}

impl SignKey {
    pub fn generate() -> SignKey {
        SignKey::from_seed(&random_bytes::<32>()).expect("a fresh seed")
    }

    pub fn from_seed(seed: &[u8]) -> Result<SignKey, String> {
        let seed: [u8; 32] = seed.try_into().map_err(|_| "an Ed25519 seed is 32 bytes".to_string())?;
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).map_err(|_| "bad Ed25519 seed".to_string())?;
        Ok(SignKey { pair, seed })
    }

    pub fn public(&self) -> [u8; 32] {
        self.pair.public_key().as_ref().try_into().expect("32-byte public key")
    }

    pub fn public_b64u(&self) -> String {
        b64u(&self.public())
    }

    pub fn seed_b64u(&self) -> String {
        b64u(&self.seed)
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.pair.sign(msg).as_ref().try_into().expect("64-byte signature")
    }

    /// Read an existing key file (never made here: a new key would not match the enrollment).
    pub fn load(path: &str) -> Result<SignKey, String> {
        if !std::path::Path::new(path).exists() {
            return Err(format!("{path}: no root key (the installer makes it at enrollment)"));
        }
        SignKey::load_or_create(path)
    }

    /// Read a key file (the b64url seed, mode 0600) or create it (0600). Returns the key.
    pub fn load_or_create(path: &str) -> Result<SignKey, String> {
        let p = std::path::Path::new(path);
        if !p.exists() {
            let k = SignKey::generate();
            write_private(p, &format!("{}\n", k.seed_b64u()))?;
            return Ok(k);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?.permissions().mode();
            if mode & 0o077 != 0 {
                return Err(format!("{path}: a root key must be mode 600 (it is {:o})", mode & 0o777));
            }
        }
        let raw = std::fs::read_to_string(p).map_err(|e| format!("{path}: {e}"))?;
        SignKey::from_seed(&unb64u(&raw).ok_or_else(|| format!("{path}: not a b64url seed"))?)
    }
}

/// Atomic 0600 write (tmp + rename).
pub fn write_private(p: &std::path::Path, text: &str) -> Result<(), String> {
    use std::io::Write as _;
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, p).map_err(|e| format!("{}: {e}", p.display()))
}

pub fn verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    public.len() == 32 && sig.len() == 64 && UnparsedPublicKey::new(&signature::ED25519, public).verify(msg, sig).is_ok()
}

/// A public key from b64url (32 bytes).
pub fn public_from_b64u(s: &str) -> Option<[u8; 32]> {
    unb64u(s)?.try_into().ok()
}

/// The key id of a token signing key (C3): `k_` + the first 16 b64url chars of sha256(public).
pub fn kid_of(public: &[u8]) -> String {
    let h = b64u(&Sha256::digest(public));
    format!("k_{}", &h[..16])
}

/* ------------------------------------------------------------------ signed JSON */

/// `msg` with `sig` = Ed25519(key) over JCS(msg without `sig`).
pub fn sign_json(key: &SignKey, mut msg: Value) -> Value {
    if let Some(o) = msg.as_object_mut() {
        o.remove("sig");
    }
    let sig = key.sign(jcs(&msg).as_bytes());
    if let Some(o) = msg.as_object_mut() {
        o.insert("sig".into(), json!(b64u(&sig)));
    }
    msg
}

/// Does `msg` carry a good `sig` by `public` over its canonical JSON without `sig`?
pub fn verify_json(public: &[u8], msg: &Value) -> bool {
    let Some(o) = msg.as_object() else { return false };
    let Some(sig) = o.get("sig").and_then(Value::as_str).and_then(unb64u) else { return false };
    let mut rest: Map<String, Value> = o.clone();
    rest.remove("sig");
    verify(public, jcs(&Value::Object(rest)).as_bytes(), &sig)
}

/* ------------------------------------------------------------------ the handshake */

fn ctx(label: &str, a: &str, b: &str, c: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(label.len() + a.len() + b.len() + c.len() + 4);
    m.extend_from_slice(label.as_bytes());
    m.push(0);
    m.extend_from_slice(a.as_bytes());
    m.push(0);
    m.extend_from_slice(b.as_bytes());
    m.push(0);
    m.extend_from_slice(c.as_bytes());
    m
}

/// What the root signs: `"ygg-trunk-v1/root-auth\0" trunk_id "\0" trunk.nonce "\0" root.nonce`.
pub fn root_auth_input(trunk_id: &str, trunk_nonce: &str, root_nonce: &str) -> Vec<u8> {
    ctx(ROOT_AUTH_CTX, trunk_id, trunk_nonce, root_nonce)
}

/// What the trunk signs: `"ygg-trunk-v1/trunk-auth\0" root_id "\0" root.nonce "\0" trunk.nonce`.
pub fn trunk_auth_input(root_id: &str, root_nonce: &str, trunk_nonce: &str) -> Vec<u8> {
    ctx(TRUNK_AUTH_CTX, root_id, root_nonce, trunk_nonce)
}

pub fn hello(trunk_id: &str, trunk_key: &str, nonce: &str) -> Value {
    json!({ "t": "hello", "proto": PROTO, "trunk_id": trunk_id, "trunk_key": trunk_key, "nonce": nonce })
}

pub fn auth(root_key: &SignKey, root_id: &str, trunk_id: &str, trunk_nonce: &str, root_nonce: &str) -> Value {
    let sig = root_key.sign(&root_auth_input(trunk_id, trunk_nonce, root_nonce));
    json!({ "t": "auth", "proto": PROTO, "root_id": root_id, "nonce": root_nonce, "sig": b64u(&sig) })
}

/// Why a handshake message is refused (the words the console and the meter use).
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// proto ≠ 2 or the wrong message
    Proto(String),
    /// the hello names another trunk key than the one this root was enrolled with
    WrongTrunk,
    /// a signature does not verify
    BadSig,
    /// the trunk does not know this root id (or its key is refused: revoked)
    UnknownRoot,
    Revoked,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Proto(m) => write!(f, "protocol: {m}"),
            Refusal::WrongTrunk => write!(f, "this is not the trunk this root was enrolled with (trunk key differs)"),
            Refusal::BadSig => write!(f, "bad signature"),
            Refusal::UnknownRoot => write!(f, "unknown root"),
            Refusal::Revoked => write!(f, "revoked by trunk"),
        }
    }
}

/// The root checks the trunk's hello: proto 2, and the trunk key it was enrolled with.
/// Returns (trunk_id, trunk nonce).
pub fn check_hello(v: &Value, enrolled_trunk_key: &str) -> Result<(String, String), Refusal> {
    if v["t"] != "hello" {
        return Err(Refusal::Proto(format!("expected hello, got {}", v["t"])));
    }
    if v["proto"].as_u64() != Some(PROTO) {
        return Err(Refusal::Proto(format!("trunk speaks proto {} (this root speaks {PROTO})", v["proto"])));
    }
    let got = v["trunk_key"].as_str().unwrap_or_default();
    if !ct_eq(got.trim().as_bytes(), enrolled_trunk_key.trim().as_bytes()) {
        return Err(Refusal::WrongTrunk);
    }
    let (Some(id), Some(n)) = (v["trunk_id"].as_str(), v["nonce"].as_str()) else {
        return Err(Refusal::Proto("hello without trunk_id or nonce".into()));
    };
    if n.len() < 16 || id.is_empty() {
        return Err(Refusal::Proto("hello: short nonce".into()));
    }
    Ok((id.to_string(), n.to_string()))
}

/// The trunk checks a root's auth against the root's enrolled public key.
/// Returns (root_id, root nonce). `root_pub(id)` = the key on file (None = unknown root).
pub fn check_auth(v: &Value, trunk_id: &str, trunk_nonce: &str, root_pub: impl Fn(&str) -> Result<[u8; 32], Refusal>) -> Result<(String, String), Refusal> {
    if v["t"] != "auth" {
        return Err(Refusal::Proto(format!("expected auth, got {}", v["t"])));
    }
    if v["proto"].as_u64() != Some(PROTO) {
        return Err(Refusal::Proto(format!("root speaks proto {}", v["proto"])));
    }
    let (Some(id), Some(n), Some(sig)) = (v["root_id"].as_str(), v["nonce"].as_str(), v["sig"].as_str().and_then(unb64u)) else {
        return Err(Refusal::Proto("auth without root_id, nonce or sig".into()));
    };
    if n.len() < 16 {
        return Err(Refusal::Proto("auth: short nonce".into()));
    }
    let public = root_pub(id)?;
    if !verify(&public, &root_auth_input(trunk_id, trunk_nonce, n), &sig) {
        return Err(Refusal::BadSig);
    }
    Ok((id.to_string(), n.to_string()))
}

/// The welcome's `sig` field.
pub fn welcome_sig(trunk_key: &SignKey, root_id: &str, root_nonce: &str, trunk_nonce: &str) -> String {
    b64u(&trunk_key.sign(&trunk_auth_input(root_id, root_nonce, trunk_nonce)))
}

/// The root checks the welcome's signature with the trunk key it was enrolled with.
pub fn check_welcome(v: &Value, trunk_key: &[u8], root_id: &str, root_nonce: &str, trunk_nonce: &str) -> Result<(), Refusal> {
    if v["t"] == "refused" {
        return Err(match v["why"].as_str() {
            Some("revoked") => Refusal::Revoked,
            Some("unknown") => Refusal::UnknownRoot,
            Some(w) => Refusal::Proto(w.to_string()),
            None => Refusal::Proto("refused".into()),
        });
    }
    if v["t"] != "welcome" {
        return Err(Refusal::Proto(format!("expected welcome, got {}", v["t"])));
    }
    let Some(sig) = v["sig"].as_str().and_then(unb64u) else { return Err(Refusal::BadSig) };
    if !verify(trunk_key, &trunk_auth_input(root_id, root_nonce, trunk_nonce), &sig) {
        return Err(Refusal::BadSig);
    }
    Ok(())
}

/* ------------------------------------------------------------------ the directory */

/// One root in the signed directory (C5).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DirRoot {
    pub id: String,
    pub name: String,
    pub wg_pub: String,
    pub wg_addr: String,
    pub dtls_fp: String,
    pub has_app: bool,
    pub has_voice: bool,
    pub online: bool,
    pub peer_token_sha256: String,
}

/// A directory signed by the trunk key: `{seq, issued_at, roots, sig}`.
pub fn sign_directory(key: &SignKey, seq: u64, issued_at: u64, roots: &[DirRoot]) -> Value {
    sign_json(key, json!({ "seq": seq, "issued_at": issued_at, "roots": roots }))
}

/// The roots of a directory whose own signature verifies (None = unsigned, forged, malformed).
pub fn verify_directory(trunk_key: &[u8], dir: &Value) -> Option<(u64, Vec<DirRoot>)> {
    if !verify_json(trunk_key, dir) {
        return None;
    }
    let seq = dir["seq"].as_u64()?;
    let roots: Vec<DirRoot> = serde_json::from_value(dir["roots"].clone()).ok()?;
    Some((seq, roots))
}

/* ------------------------------------------------------------------ PASETO v4.public (verify) */

/// PASETO PAE (pre-authentication encoding).
pub fn pae(pieces: &[&[u8]]) -> Vec<u8> {
    let le64 = |n: u64| (n & 0x7fff_ffff_ffff_ffff).to_le_bytes();
    let mut out = le64(pieces.len() as u64).to_vec();
    for p in pieces {
        out.extend_from_slice(&le64(p.len() as u64));
        out.extend_from_slice(p);
    }
    out
}

/// A verified v4.public token: (claims JSON, footer bytes). `key_for(footer)` picks the public key
/// (by the footer's `kid`); None = no such non-retired key.
pub fn paseto_v4_verify(token: &str, key_for: impl Fn(&[u8]) -> Option<[u8; 32]>) -> Option<(Value, Vec<u8>)> {
    let rest = token.trim().strip_prefix("v4.public.")?;
    let (body, footer) = match rest.split_once('.') {
        Some((b, f)) => (b, unb64u(f)?),
        None => (rest, vec![]),
    };
    let raw = unb64u(body)?;
    if raw.len() < 64 {
        return None;
    }
    let (m, sig) = raw.split_at(raw.len() - 64);
    let public = key_for(&footer)?;
    let m2 = pae(&[b"v4.public.", m, &footer, b""]);
    if !verify(&public, &m2, sig) {
        return None;
    }
    Some((serde_json::from_slice(m).ok()?, footer))
}

/// Sign a v4.public token (the IDP mints for real; this is for tests and rigs).
pub fn paseto_v4_sign(key: &SignKey, claims: &Value, footer: &[u8]) -> String {
    let m = claims.to_string().into_bytes();
    let m2 = pae(&[b"v4.public.", &m, footer, b""]);
    let sig = key.sign(&m2);
    let mut body = m;
    body.extend_from_slice(&sig);
    if footer.is_empty() {
        format!("v4.public.{}", b64u(&body))
    } else {
        format!("v4.public.{}.{}", b64u(&body), b64u(footer))
    }
}

/// RFC 3339 UTC with second precision and `Z` (C3 `iat`/`exp`).
pub fn rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

/// `2026-11-25T22:30:00Z` (or with a fraction) → unix ms.
pub fn parse_rfc3339(t: &str) -> Option<u64> {
    let b = t.as_bytes();
    if !t.is_ascii() || b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') || !(t.ends_with('Z') || t.ends_with('z')) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let frac = t[19..t.len() - 1].strip_prefix('.').unwrap_or("");
    if !frac.bytes().all(|c| c.is_ascii_digit()) || (frac.is_empty() && t.len() != 20) {
        return None;
    }
    let ms = if frac.is_empty() { 0 } else { format!("{:0<3}", &frac[..frac.len().min(3)]).parse::<i64>().ok()? };
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000) + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip() {
        let m = mux(CTRL, 0, b"{}");
        assert_eq!(unmux(&m), Some((CTRL, 0, &b"{}"[..])));
        let m = mux(DATA, 0xdead_beef, b"x");
        assert_eq!(unmux(&m), Some((DATA, 0xdead_beef, &b"x"[..])));
        assert_eq!(unmux(&[1, 2]), None);
        assert_eq!(parse_ctrl(b"[1]"), None, "a CTRL payload is one object");
        assert_eq!(parse_ctrl(b"{\"t\":\"probe\"}").unwrap()["t"], "probe");
    }

    #[test]
    fn jcs_matches_rfc8785() {
        // RFC 8785 §3.2.3 sorting example (UTF-16 code unit order)
        let v: Value = serde_json::from_str(r#"{"€":"Euro Sign","\r":"Carriage Return","דּ":"Hebrew Letter Dalet With Dagesh","1":"One","😀":"Emoji: Grinning Face","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis"}"#).unwrap();
        assert_eq!(
            jcs(&v),
            "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u{80}\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"\u{fb33}\":\"Hebrew Letter Dalet With Dagesh\"}"
        );
        // RFC 8785 §3.2.2 primitive serialization
        let v: Value = serde_json::from_str(r#"{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}"#).unwrap();
        // serde_json without float_roundtrip may parse a decimal 1 ulp off: the doubles themselves
        let mut v = v;
        v["numbers"] = json!([333333333.33333329_f64, 1e30_f64, 4.50_f64, 2e-3_f64, 0.000000000000000000000000001_f64]);
        assert_eq!(
            jcs(&v),
            r#"{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}"#
        );
        assert_eq!(es_number(1e21), "1e+21");
        assert_eq!(es_number(1e20), "100000000000000000000");
        assert_eq!(es_number(-0.5), "-0.5");
        assert_eq!(es_number(1.5e-7), "1.5e-7");
        assert_eq!(jcs(&json!({"b": 1, "a": [1, {"d": 2, "c": 3}]})), r#"{"a":[1,{"c":3,"d":2}],"b":1}"#);
    }

    #[test]
    fn signed_json_and_directory() {
        let k = SignKey::generate();
        let other = SignKey::generate();
        let m = sign_json(&k, json!({ "t": "revoke", "did": "dev_x", "until": 5 }));
        assert!(verify_json(&k.public(), &m));
        assert!(!verify_json(&other.public(), &m), "another key");
        let mut t = m.clone();
        t["until"] = json!(6);
        assert!(!verify_json(&k.public(), &t), "a changed field");
        let mut t = m.clone();
        t.as_object_mut().unwrap().remove("sig");
        assert!(!verify_json(&k.public(), &t), "unsigned");
        // member order on the wire does not matter, the canonical form does
        let reordered: Value = serde_json::from_str(&format!(
            r#"{{"until":5,"sig":{},"did":"dev_x","t":"revoke"}}"#,
            m["sig"]
        ))
        .unwrap();
        assert!(verify_json(&k.public(), &reordered));
        let r = DirRoot {
            id: "rt_a".into(),
            name: "a".into(),
            wg_pub: "x".into(),
            wg_addr: "10.77.0.2".into(),
            dtls_fp: "sha-256 AB".into(),
            has_app: true,
            has_voice: false,
            online: true,
            peer_token_sha256: "00".into(),
        };
        let d = sign_directory(&k, 7, 1000, std::slice::from_ref(&r));
        assert_eq!(verify_directory(&k.public(), &d), Some((7, vec![r.clone()])));
        let mut bad = d.clone();
        bad["roots"][0]["wg_pub"] = json!("evil");
        assert_eq!(verify_directory(&k.public(), &bad), None);
        assert_eq!(verify_directory(&other.public(), &d), None);
    }

    #[test]
    fn handshake_both_ways_and_refusals() {
        let trunk = SignKey::generate();
        let root = SignKey::generate();
        let (tn, rn) = (nonce(), nonce());
        let h = hello("trk_1", &trunk.public_b64u(), &tn);
        assert_eq!(check_hello(&h, &trunk.public_b64u()), Ok(("trk_1".into(), tn.clone())));
        assert_eq!(check_hello(&h, &SignKey::generate().public_b64u()), Err(Refusal::WrongTrunk));
        let mut old = h.clone();
        old["proto"] = json!(1);
        assert!(matches!(check_hello(&old, &trunk.public_b64u()), Err(Refusal::Proto(_))));
        let a = auth(&root, "rt_a", "trk_1", &tn, &rn);
        let pubk = root.public();
        let lookup = |id: &str| if id == "rt_a" { Ok(pubk) } else { Err(Refusal::UnknownRoot) };
        assert_eq!(check_auth(&a, "trk_1", &tn, lookup), Ok(("rt_a".into(), rn.clone())));
        // a replay against another trunk nonce, another trunk, another key: refused
        assert_eq!(check_auth(&a, "trk_1", &nonce(), lookup), Err(Refusal::BadSig));
        assert_eq!(check_auth(&a, "trk_2", &tn, lookup), Err(Refusal::BadSig));
        let forged = auth(&SignKey::generate(), "rt_a", "trk_1", &tn, &rn);
        assert_eq!(check_auth(&forged, "trk_1", &tn, lookup), Err(Refusal::BadSig));
        let unknown = auth(&root, "rt_b", "trk_1", &tn, &rn);
        assert_eq!(check_auth(&unknown, "trk_1", &tn, lookup), Err(Refusal::UnknownRoot));
        let w = json!({ "t": "welcome", "sig": welcome_sig(&trunk, "rt_a", &rn, &tn) });
        assert_eq!(check_welcome(&w, &trunk.public(), "rt_a", &rn, &tn), Ok(()));
        // a front that terminates TLS cannot sign as the trunk
        let fake = json!({ "t": "welcome", "sig": welcome_sig(&SignKey::generate(), "rt_a", &rn, &tn) });
        assert_eq!(check_welcome(&fake, &trunk.public(), "rt_a", &rn, &tn), Err(Refusal::BadSig));
        // the root signs its own nonce: the trunk's answer for another nonce does not pass
        assert_eq!(check_welcome(&w, &trunk.public(), "rt_a", &nonce(), &tn), Err(Refusal::BadSig));
        assert_eq!(check_welcome(&json!({"t":"refused","why":"revoked"}), &trunk.public(), "rt_a", &rn, &tn), Err(Refusal::Revoked));
        // the two contexts never collide
        assert_ne!(root_auth_input("a", "b", "c"), trunk_auth_input("a", "b", "c"));
    }

    #[test]
    fn paseto_v4_public_roundtrip() {
        let k = SignKey::generate();
        let footer = json!({ "kid": kid_of(&k.public()) }).to_string();
        let claims = json!({ "iss": "https://t", "sub": "acc_1", "did": "dev_1", "role": "admin", "rgn": "loopback", "kep": 0,
                             "iat": rfc3339(1_764_100_000_000), "exp": rfc3339(1_764_100_900_000), "jti": "x" });
        let tok = paseto_v4_sign(&k, &claims, footer.as_bytes());
        let pk = k.public();
        let (got, f) = paseto_v4_verify(&tok, |_| Some(pk)).unwrap();
        assert_eq!(got, claims);
        assert_eq!(f, footer.as_bytes());
        assert!(paseto_v4_verify(&tok, |_| Some(SignKey::generate().public())).is_none());
        let mut bad = tok.clone();
        bad.replace_range(20..21, if &bad[20..21] == "A" { "B" } else { "A" });
        assert!(paseto_v4_verify(&bad, |_| Some(pk)).is_none());
        assert!(paseto_v4_verify("v2.public.xx", |_| Some(pk)).is_none());
        assert_eq!(rfc3339(1_764_100_000_000), "2025-11-25T19:46:40Z");
        assert_eq!(parse_rfc3339("2025-11-25T19:46:40Z"), Some(1_764_100_000_000));
        assert_eq!(parse_rfc3339("2025-11-25T19:46:40.5Z"), Some(1_764_100_000_500));
        assert_eq!(parse_rfc3339("2025-13-25T19:46:40Z"), None);
        assert_eq!(kid_of(&pk).len(), 18);
    }

    /// The official PASETO v4.public vector 4-S-1 (paseto-spec, docs/vectors/v4.json).
    #[test]
    fn paseto_official_vector_4_s_1() {
        let pk_hex = "1eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2";
        let pk: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&pk_hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        let token = "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA";
        let pk: [u8; 32] = pk.try_into().unwrap();
        let (claims, footer) = paseto_v4_verify(token, |_| Some(pk)).expect("official vector verifies");
        assert_eq!(claims["data"], "this is a signed message");
        assert!(footer.is_empty());
        // Ed25519 is deterministic: the vector's secret key signs the same token
        let sk_hex = "b4cbfb43df4ce210727d953e4a713307fa19bb7d9f85041438d9e11b942a3774";
        let seed: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&sk_hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        let k = SignKey::from_seed(&seed).unwrap();
        assert_eq!(k.public(), pk);
        let m = &unb64u(&token["v4.public.".len()..]).unwrap();
        let m = &m[..m.len() - 64];
        let m2 = pae(&[b"v4.public.", m, b"", b""]);
        let mut body = m.to_vec();
        body.extend_from_slice(&k.sign(&m2));
        assert_eq!(format!("v4.public.{}", b64u(&body)), token);
    }
}
