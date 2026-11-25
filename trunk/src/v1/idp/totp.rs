//! TOTP (RFC 6238): SHA-1, 6 digits, 30 s, ±1 step, each step used once; 160-bit seed.

use ring::hmac;

pub const DIGITS: u32 = 6;
pub const PERIOD: i64 = 30;

/// HOTP (RFC 4226) with `digits` digits.
pub fn hotp(secret: &[u8], counter: u64, digits: u32) -> u32 {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let mac = hmac::sign(&key, &counter.to_be_bytes());
    let h = mac.as_ref();
    let off = (h[19] & 0x0f) as usize;
    let bin = ((h[off] as u32 & 0x7f) << 24) | ((h[off + 1] as u32) << 16) | ((h[off + 2] as u32) << 8) | h[off + 3] as u32;
    bin % 10u32.pow(digits)
}

pub fn step_of(unix_s: i64) -> i64 {
    unix_s.div_euclid(PERIOD)
}

pub fn code_at(secret: &[u8], unix_s: i64) -> String {
    format!("{:06}", hotp(secret, step_of(unix_s) as u64, DIGITS))
}

/// The step a typed code matches (now ±1), only when it is newer than `last_step`. Constant-time
/// compare of the six digits.
pub fn verify(secret: &[u8], code: &str, unix_s: i64, last_step: i64) -> Option<i64> {
    let code: String = code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let now = step_of(unix_s);
    let mut hit = None;
    for s in [now - 1, now, now + 1] {
        let want = format!("{:06}", hotp(secret, s as u64, DIGITS));
        if crate::v1::crypto::ct_eq(want.as_bytes(), code.as_bytes()) && s > last_step && hit.is_none() {
            hit = Some(s);
        }
    }
    hit
}

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32, no padding (what authenticator apps take).
pub fn b32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((buf >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn unb32(s: &str) -> Option<Vec<u8>> {
    let (mut buf, mut bits, mut out) = (0u32, 0u32, vec![]);
    for c in s.trim_end_matches('=').bytes() {
        let v = B32.iter().position(|&x| x == c.to_ascii_uppercase())? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push((buf >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~@".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// `otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`
pub fn uri(issuer: &str, account: &str, secret: &[u8]) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
        enc(issuer),
        enc(account),
        b32(secret),
        enc(issuer)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B, SHA-1 (seed "12345678901234567890"): the 8-digit values, and their
    /// last six digits as the 6-digit codes.
    #[test]
    fn rfc6238_sha1_vectors() {
        let seed = b"12345678901234567890";
        for (t, want) in [
            (59i64, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
            (20000000000, "65353130"),
        ] {
            assert_eq!(format!("{:08}", hotp(seed, step_of(t) as u64, 8)), want, "t={t}");
            assert_eq!(code_at(seed, t), want[2..], "t={t} (6 digits)");
        }
    }

    #[test]
    fn plus_minus_one_step_and_each_step_once() {
        let seed = b"12345678901234567890";
        let t = 1111111111;
        let now = code_at(seed, t);
        let s = verify(seed, &now, t, 0).unwrap();
        assert_eq!(s, step_of(t));
        assert_eq!(verify(seed, &now, t, s), None, "the same step twice is refused");
        assert!(verify(seed, &code_at(seed, t - 30), t, 0).is_some(), "previous step accepted");
        assert!(verify(seed, &code_at(seed, t + 30), t, 0).is_some(), "next step accepted");
        assert_eq!(verify(seed, &code_at(seed, t - 60), t, 0), None, "two steps back refused");
        assert_eq!(verify(seed, &code_at(seed, t + 60), t, 0), None, "two steps ahead refused");
        assert_eq!(verify(seed, &code_at(seed, t - 30), t, s), None, "an older step after a newer one is refused");
        assert!(verify(seed, &format!("{} {}", &now[..3], &now[3..]), t, 0).is_some(), "spaces are fine");
        assert_eq!(verify(seed, "12345", t, 0), None);
        assert_eq!(verify(seed, "abcdef", t, 0), None);
    }

    #[test]
    fn base32_and_uri() {
        assert_eq!(b32(b"foobar"), "MZXW6YTBOI");
        assert_eq!(unb32("MZXW6YTBOI").unwrap(), b"foobar");
        let s = [0xA5u8; 20];
        assert_eq!(unb32(&b32(&s)).unwrap(), s);
        assert_eq!(b32(&s).len(), 32, "160 bits");
        let u = uri("ljoolq.veraldar.org", "owner@example.org", &s);
        assert!(u.starts_with("otpauth://totp/ljoolq.veraldar.org:owner@example.org?secret="), "{u}");
        assert!(u.ends_with("&issuer=ljoolq.veraldar.org&algorithm=SHA1&digits=6&period=30"));
    }
}
