//! PASETO v4.public (Ed25519) — the access token of CONTRACTS.md C3, and the one verifier every
//! party runs (trunk here; the root app and the bridge run the same checks in the same order).
//!
//! Token: `v4.public.<b64url(m ‖ sig)>[.<b64url(footer)>]`, sig = Ed25519 over
//! PAE("v4.public.", m, footer, implicit) — implicit assertion empty for C3 tokens.

use serde::{Deserialize, Serialize};

use super::crypto::{b64u, ed25519_verify, unb64u, SigningKey};

const HEADER: &str = "v4.public.";

/// Pre-Authentication Encoding (PASETO spec §2.2).
pub fn pae(pieces: &[&[u8]]) -> Vec<u8> {
    let le64 = |n: u64| (n & (u64::MAX >> 1)).to_le_bytes();
    let mut out = le64(pieces.len() as u64).to_vec();
    for p in pieces {
        out.extend_from_slice(&le64(p.len() as u64));
        out.extend_from_slice(p);
    }
    out
}

pub fn sign(key: &SigningKey, message: &[u8], footer: &[u8], implicit: &[u8]) -> String {
    let m2 = pae(&[HEADER.as_bytes(), message, footer, implicit]);
    let sig = key.sign(&m2);
    let mut body = message.to_vec();
    body.extend_from_slice(&sig);
    let mut t = format!("{HEADER}{}", b64u(&body));
    if !footer.is_empty() {
        t.push('.');
        t.push_str(&b64u(footer));
    }
    t
}

/// The footer of a token, unverified (to pick the key by `kid`).
pub fn footer_of(token: &str) -> Option<Vec<u8>> {
    let rest = token.strip_prefix(HEADER)?;
    let mut parts = rest.split('.');
    let _body = parts.next()?;
    let f = match parts.next() {
        Some(f) => unb64u(f)?,
        None => vec![],
    };
    if parts.next().is_some() {
        return None;
    }
    Some(f)
}

/// Verify the signature; returns the message. `footer` must match exactly.
pub fn verify(public: &[u8], token: &str, implicit: &[u8]) -> Option<Vec<u8>> {
    let rest = token.strip_prefix(HEADER)?;
    let mut parts = rest.split('.');
    let body_b64 = parts.next()?;
    let footer = match parts.next() {
        Some(f) => unb64u(f)?,
        None => vec![],
    };
    if parts.next().is_some() {
        return None;
    }
    // canonical b64url only: no padding, no foreign alphabet
    if body_b64.contains('=') || body_b64.contains('+') || body_b64.contains('/') {
        return None;
    }
    let body = unb64u(body_b64)?;
    if body.len() < 64 {
        return None;
    }
    let (m, sig) = body.split_at(body.len() - 64);
    let m2 = pae(&[HEADER.as_bytes(), m, &footer, implicit]);
    ed25519_verify(public, &m2, sig).then(|| m.to_vec())
}

// ---- C3 access tokens --------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub did: String,
    pub role: String,
    pub rgn: String,
    pub kep: u64,
    pub iat: String,
    pub exp: String,
    pub jti: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Footer {
    kid: String,
}

#[derive(Debug, Clone)]
pub struct VerifyKey {
    pub kid: String,
    pub public: Vec<u8>,
    pub retired: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Missing,
    Invalid,
    Expired,
    Region,
    Revoked,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Missing => "missing",
            Why::Invalid => "invalid",
            Why::Expired => "expired",
            Why::Region => "region",
            Why::Revoked => "revoked",
        }
    }
    /// `expired`/`region` → refresh, everything else → login (C3).
    pub fn reauth(self) -> &'static str {
        match self {
            Why::Expired | Why::Region => "refresh",
            _ => "login",
        }
    }
    pub fn body(self) -> String {
        serde_json::json!({ "why": self.as_str(), "reauth": self.reauth() }).to_string()
    }
}

/// What a verifier knows besides the token.
pub struct Ctx<'a> {
    /// unix seconds
    pub now: i64,
    /// region class of the request's REAL client address (region.rs)
    pub region: &'a str,
    pub kill_epoch: u64,
    /// `did` currently denied (deny-list entry whose `until` has not passed)
    pub denied: &'a dyn Fn(&str) -> bool,
}

pub fn mint(key: &SigningKey, claims: &Claims) -> String {
    let footer = serde_json::to_vec(&Footer { kid: key.kid() }).expect("footer json");
    let msg = serde_json::to_vec(claims).expect("claims json");
    sign(key, &msg, &footer, b"")
}

/// The C3 checks, in the C3 order: signature with a non-retired kid → `invalid`; `exp` passed →
/// `expired`; `rgn` ≠ request region → `region`; `kep` < kill epoch → `revoked`; `did` denied →
/// `revoked`; no token → `missing`.
pub fn verify_access(token: Option<&str>, keys: &[VerifyKey], ctx: &Ctx) -> Result<Claims, Why> {
    let token = match token.map(str::trim) {
        None | Some("") => return Err(Why::Missing),
        Some(t) => t,
    };
    let footer = footer_of(token).ok_or(Why::Invalid)?;
    let f: Footer = serde_json::from_slice(&footer).map_err(|_| Why::Invalid)?;
    let key = keys.iter().find(|k| k.kid == f.kid && !k.retired).ok_or(Why::Invalid)?;
    let msg = verify(&key.public, token, b"").ok_or(Why::Invalid)?;
    let c: Claims = serde_json::from_slice(&msg).map_err(|_| Why::Invalid)?;
    let exp = parse_time(&c.exp).ok_or(Why::Invalid)?;
    parse_time(&c.iat).ok_or(Why::Invalid)?;
    if exp <= ctx.now {
        return Err(Why::Expired);
    }
    if c.rgn != ctx.region {
        return Err(Why::Region);
    }
    if c.kep < ctx.kill_epoch {
        return Err(Why::Revoked);
    }
    if (ctx.denied)(&c.did) {
        return Err(Why::Revoked);
    }
    Ok(c)
}

// ---- RFC 3339 UTC, second precision, `Z` -----------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// unix seconds → "2026-11-25T12:00:00Z"
pub fn fmt_time(t: i64) -> String {
    let (days, secs) = (t.div_euclid(86400), t.rem_euclid(86400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs / 60 % 60, secs % 60)
}

/// "2026-11-25T12:00:00Z" → unix seconds (exactly that shape, nothing else).
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = &s[r];
        t.bytes().all(|c| c.is_ascii_digit()).then(|| t.parse().ok())?
    };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if civil_from_days(days) != (y, mo, d) {
        return None;
    }
    Some(days * 86400 + h * 3600 + mi * 60 + se)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::v1::crypto::hex;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    const SEED: &str = "b4cbfb43df4ce210727d953e4a713307fa19bb7d9f85041438d9e11b942a3774";
    const PUBLIC: &str = "1eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2";
    const PAYLOAD: &str = "{\"data\":\"this is a signed message\",\"exp\":\"2022-01-01T00:00:00+00:00\"}";
    const FOOTER: &str = "{\"kid\":\"zVhMiPBP9fRf2snEcT7gFTioeA9COcNy9DfgL1W60haN\"}";

    /// The official v4.public vectors (paseto-standard/test-vectors v4.json: 4-S-1..3, 4-F-1..3).
    #[test]
    fn official_v4_public_vectors() {
        let key = SigningKey::from_seed(unhex(SEED).try_into().unwrap());
        assert_eq!(hex(&key.public()), PUBLIC);
        let cases: [(&str, &str, &str, &str); 3] = [
            ("4-S-1", "", "", "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA"),
            ("4-S-2", FOOTER, "", "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9v3Jt8mx_TdM2ceTGoqwrh4yDFn0XsHvvV_D0DtwQxVrJEBMl0F2caAdgnpKlt4p7xBnx1HcO-SPo8FPp214HDw.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9"),
            ("4-S-3", FOOTER, "{\"test-vector\":\"4-S-3\"}", "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9NPWciuD3d0o5eXJXG5pJy-DiVEoyPYWs1YSTwWHNJq6DZD3je5gf-0M4JR9ipdUSJbIovzmBECeaWmaqcaP0DQ.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9"),
        ];
        for (name, footer, implicit, token) in cases {
            assert_eq!(sign(&key, PAYLOAD.as_bytes(), footer.as_bytes(), implicit.as_bytes()), token, "{name} sign");
            assert_eq!(verify(&key.public(), token, implicit.as_bytes()).as_deref(), Some(PAYLOAD.as_bytes()), "{name} verify");
            assert!(verify(&key.public(), token, b"other").is_none(), "{name}: implicit assertion is bound");
        }
        // 4-F-1: a v4.local token handed to the public verifier; 4-F-2: a public token signed
        // with an unrelated key; 4-F-3: a v3 token
        let fails = [
            ("4-F-1", "v4.local.vngXfCISbnKgiP6VWGuOSlYrFYU300fy9ijW33rznDYgxHNPwWluAY2Bgb0z54CUs6aYYkIJ-bOOOmJHPuX_34Agt_IPlNdGDpRdGNnBz2MpWJvB3cttheEc1uyCEYltj7wBQQYX.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24", "{\"test-vector\":\"4-F-1\"}"),
            ("4-F-2", "v4.public.eyJpbnZhbGlkIjoidGhpcyBzaG91bGQgbmV2ZXIgZGVjb2RlIn22Sp4gjCaUw0c7EH84ZSm_jN_Qr41MrgLNu5LIBCzUr1pn3Z-Wukg9h3ceplWigpoHaTLcwxj0NsI1vjTh67YB.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9", "{\"test-vector\":\"4-F-2\"}"),
            ("4-F-3", "v3.local.23e_2PiqpQBPvRFKzB0zHhjmxK3sKo2grFZRRLM-U7L0a8uHxuF9RlVz3Ic6WmdUUWTxCaYycwWV1yM8gKbZB2JhygDMKvHQ7eBf8GtF0r3K0Q_gF1PXOxcOgztak1eD1dPe9rLVMSgR0nHJXeIGYVuVrVoLWQ.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24", "{\"test-vector\":\"4-F-3\"}"),
        ];
        for (name, token, implicit) in fails {
            assert!(verify(&key.public(), token, implicit.as_bytes()).is_none(), "{name} must fail");
        }
        // tampering with any byte of the body or footer breaks it
        let t = cases[1].3;
        let mut b = t.as_bytes().to_vec();
        let i = HEADER.len() + 3;
        b[i] = if b[i] == b'A' { b'B' } else { b'A' };
        assert!(verify(&key.public(), std::str::from_utf8(&b).unwrap(), b"").is_none());
        assert!(verify(&key.public(), &format!("{t}x"), b"").is_none());
    }

    #[test]
    fn pae_matches_the_spec_examples() {
        assert_eq!(pae(&[]), b"\x00\x00\x00\x00\x00\x00\x00\x00");
        assert_eq!(pae(&[b""]), b"\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00");
        assert_eq!(
            pae(&[b"test"]),
            b"\x01\x00\x00\x00\x00\x00\x00\x00\x04\x00\x00\x00\x00\x00\x00\x00test"
        );
    }

    #[test]
    fn times_round_trip() {
        for t in [0i64, 1764072000, 951782400, 4102444799, 1709164800] {
            assert_eq!(parse_time(&fmt_time(t)), Some(t), "{}", fmt_time(t));
        }
        assert_eq!(fmt_time(1764072000), "2025-11-25T12:00:00Z");
        assert_eq!(parse_time("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_time("2026-01-01T00:00:00+00:00"), None);
        assert_eq!(parse_time("2026-01-01T00:00:00.5Z"), None);
    }

    // ---- C3 shared vectors: docs/trunk-v1/vectors/paseto.json --------------------------------

    pub const VEC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/trunk-v1/vectors/paseto.json");

    /// Build the C3 vector file from fixed inputs (Ed25519 is deterministic, so it is stable).
    pub fn build_vectors() -> serde_json::Value {
        use serde_json::json;
        let seed: [u8; 32] = crate::v1::crypto::sha256(b"ygg-trunk-v1/test-vector-key-1");
        let key = SigningKey::from_seed(seed);
        let old = SigningKey::from_seed(crate::v1::crypto::sha256(b"ygg-trunk-v1/test-vector-key-0-retired"));
        let other = SigningKey::from_seed(crate::v1::crypto::sha256(b"ygg-trunk-v1/not-a-trunk-key"));
        let iat = 1764072000i64; // 2025-11-25T12:00:00Z
        let base = Claims {
            iss: "https://ljoolq.veraldar.org".into(),
            sub: "acc_TESTaccount000000".into(),
            did: "dev_TESTdevice0000000".into(),
            role: "admin".into(),
            rgn: "net:8.8.0.0/16".into(),
            kep: 3,
            iat: fmt_time(iat),
            exp: fmt_time(iat + 900),
            jti: b64u(&crate::v1::crypto::sha256(b"jti-1")[..16]),
        };
        let token = mint(&key, &base);
        let footer = String::from_utf8(footer_of(&token).unwrap()).unwrap();
        let keys = json!([
            { "kid": key.kid(), "alg": "ed25519", "public": b64u(&key.public()), "retired_at": null },
            { "kid": old.kid(), "alg": "ed25519", "public": b64u(&old.public()), "retired_at": 1764000000000u64 },
        ]);
        let ok_ctx = json!({ "now": iat + 60, "region": base.rgn, "kill_epoch": 3, "deny": [] });
        let with = |f: &dyn Fn(&mut Claims)| {
            let mut c = base.clone();
            f(&mut c);
            mint(&key, &c)
        };
        let mut tampered = token.clone().into_bytes();
        let i = HEADER.len() + 20;
        tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        let ctx = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut c = ok_ctx.clone();
            f(&mut c);
            c
        };
        let deny_until = (iat + 900) * 1000;
        let unsigned_extra = {
            // a payload with a key C3 does not have, correctly signed: still invalid ("exactly these keys")
            let mut v = serde_json::to_value(&base).unwrap();
            v["admin"] = json!(true);
            let foot = serde_json::to_vec(&json!({ "kid": key.kid() })).unwrap();
            sign(&key, &serde_json::to_vec(&v).unwrap(), &foot, b"")
        };
        let cases = json!([
            { "name": "ok", "token": token, "ctx": ok_ctx, "expect": { "ok": true, "did": base.did, "sub": base.sub, "role": "admin" } },
            { "name": "missing", "token": "", "ctx": ok_ctx, "expect": { "why": "missing", "reauth": "login" } },
            { "name": "invalid: tampered signature", "token": tampered, "ctx": ok_ctx, "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "invalid: signed by a key not in keys[]", "token": mint(&other, &base), "ctx": ok_ctx, "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "invalid: retired kid", "token": mint(&old, &base), "ctx": ok_ctx, "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "invalid: not v4.public", "token": token.replacen("v4.public.", "v4.local.", 1), "ctx": ok_ctx, "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "invalid: extra claim", "token": unsigned_extra, "ctx": ok_ctx, "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "expired", "token": token, "ctx": ctx(&|c| c["now"] = json!(iat + 900)), "expect": { "why": "expired", "reauth": "refresh" } },
            { "name": "region", "token": token, "ctx": ctx(&|c| c["region"] = json!("lan:192.168.1.0/24")), "expect": { "why": "region", "reauth": "refresh" } },
            { "name": "revoked: kill epoch moved", "token": token, "ctx": ctx(&|c| c["kill_epoch"] = json!(4)), "expect": { "why": "revoked", "reauth": "login" } },
            { "name": "revoked: did on the deny-list", "token": token, "ctx": ctx(&|c| c["deny"] = json!([{ "did": base.did, "until": deny_until }])), "expect": { "why": "revoked", "reauth": "login" } },
            { "name": "ok: deny entry for another device", "token": token, "ctx": ctx(&|c| c["deny"] = json!([{ "did": "dev_other", "until": deny_until }])), "expect": { "ok": true, "did": base.did, "sub": base.sub, "role": "admin" } },
            { "name": "ok: deny entry already past its until", "token": token, "ctx": ctx(&|c| c["deny"] = json!([{ "did": base.did, "until": (iat + 30) * 1000 }])), "expect": { "ok": true, "did": base.did, "sub": base.sub, "role": "admin" } },
            { "name": "order: expired beats region", "token": token, "ctx": ctx(&|c| { c["now"] = json!(iat + 901); c["region"] = json!("loopback"); }), "expect": { "why": "expired", "reauth": "refresh" } },
            { "name": "order: region beats revoked", "token": token, "ctx": ctx(&|c| { c["region"] = json!("loopback"); c["kill_epoch"] = json!(9); }), "expect": { "why": "region", "reauth": "refresh" } },
            { "name": "order: invalid beats expired", "token": tampered, "ctx": ctx(&|c| c["now"] = json!(iat + 9999)), "expect": { "why": "invalid", "reauth": "login" } },
            { "name": "ok: kep above the epoch seen", "token": with(&|c| c.kep = 5), "ctx": ok_ctx, "expect": { "ok": true, "did": base.did, "sub": base.sub, "role": "admin" } },
            { "name": "ok: member role", "token": with(&|c| c.role = "member".into()), "ctx": ok_ctx, "expect": { "ok": true, "did": base.did, "sub": base.sub, "role": "member" } },
        ]);
        json!({
            "about": "CONTRACTS.md C3 shared vectors (written by IDP, trunk/src/v1/paseto.rs build_vectors). Every verifier (trunk, branch/lib/trunk-auth.ts, the bridge) runs every case: ctx.now is unix seconds, ctx.region the request's region class, ctx.kill_epoch the epoch seen, ctx.deny the deny-list ({did, until unix ms}; an entry counts while until > now*1000). Checks in order: signature with a non-retired kid → invalid; exp ≤ now → expired; rgn ≠ region → region; kep < kill_epoch → revoked; did denied → revoked; no token → missing. Regenerate: WRITE_VECTORS=1 cargo test vectors_file",
            "version": 1,
            "alg": "v4.public (Ed25519), implicit assertion empty",
            "secret_seed_b64url": b64u(&seed),
            "public_b64url": b64u(&key.public()),
            "kid": key.kid(),
            "keys": keys,
            "claims": base,
            "footer": footer,
            "token": token,
            "cases": cases,
        })
    }

    /// Run one vector case through this verifier; returns (why|"ok", did)
    pub fn run_case(v: &serde_json::Value, case: &serde_json::Value) -> Result<Claims, Why> {
        let keys: Vec<VerifyKey> = v["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| VerifyKey {
                kid: k["kid"].as_str().unwrap().into(),
                public: unb64u(k["public"].as_str().unwrap()).unwrap(),
                retired: !k["retired_at"].is_null(),
            })
            .collect();
        let c = &case["ctx"];
        let now = c["now"].as_i64().unwrap();
        let deny: Vec<(String, i64)> = c["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| (d["did"].as_str().unwrap().to_string(), d["until"].as_i64().unwrap()))
            .collect();
        let denied = |did: &str| deny.iter().any(|(d, until)| d == did && *until > now * 1000);
        let ctx = Ctx { now, region: c["region"].as_str().unwrap(), kill_epoch: c["kill_epoch"].as_u64().unwrap(), denied: &denied };
        let t = case["token"].as_str().unwrap();
        verify_access(Some(t), &keys, &ctx)
    }

    #[test]
    fn vectors_file() {
        let built = build_vectors();
        let text = serde_json::to_string_pretty(&built).unwrap() + "\n";
        if std::env::var("WRITE_VECTORS").is_ok() {
            std::fs::create_dir_all(std::path::Path::new(VEC_PATH).parent().unwrap()).unwrap();
            std::fs::write(VEC_PATH, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(VEC_PATH).expect("docs/trunk-v1/vectors/paseto.json (WRITE_VECTORS=1 cargo test vectors_file)");
        let v: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(v, built, "the vector file is what build_vectors makes");
        let mut whys = std::collections::BTreeSet::new();
        for case in v["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let got = run_case(&v, case);
            let e = &case["expect"];
            if e["ok"] == true {
                let c = got.unwrap_or_else(|w| panic!("{name}: expected ok, got {}", w.as_str()));
                assert_eq!(c.did, e["did"].as_str().unwrap(), "{name}");
                assert_eq!(c.role, e["role"].as_str().unwrap(), "{name}");
            } else {
                let w = got.err().unwrap_or_else(|| panic!("{name}: expected {}", e["why"]));
                assert_eq!(w.as_str(), e["why"].as_str().unwrap(), "{name}");
                assert_eq!(w.reauth(), e["reauth"].as_str().unwrap(), "{name}");
                whys.insert(w.as_str());
            }
        }
        assert_eq!(whys.into_iter().collect::<Vec<_>>(), ["expired", "invalid", "missing", "region", "revoked"], "one case per why");
    }
}
