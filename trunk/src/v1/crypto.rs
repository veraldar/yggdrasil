//! The trunk's primitives (CONTRACTS.md C1): AES-256-GCM under `trunk-kek`, Ed25519, constant-time
//! compare, b64url, sha256, random secrets. Proven crates only (ring, subtle, sha2), nothing hand-rolled.

use base64::Engine as _;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};

pub const B64U: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn b64u(b: &[u8]) -> String {
    B64U.encode(b)
}

pub fn unb64u(s: &str) -> Option<Vec<u8>> {
    B64U.decode(s.trim().trim_end_matches('=')).ok()
}

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&sha256(b))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Constant-time equality (the *fix* for `ap.rs`'s plain `!=`). Lengths are not secret.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq as _;
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    SystemRandom::new().fill(&mut b).expect("system random");
    b
}

/// `<prefix>` + b64url(n random bytes), e.g. `bfnr-…` (32 B) for a refresh token.
pub fn secret(prefix: &str, n: usize) -> String {
    let mut b = vec![0u8; n];
    SystemRandom::new().fill(&mut b).expect("system random");
    format!("{prefix}{}", b64u(&b))
}

/// A uniformly random integer in 0..n (rejection sampling; n ≤ 2^32).
pub fn random_below(n: u32) -> u32 {
    let zone = u32::MAX - (u32::MAX % n);
    loop {
        let v = u32::from_be_bytes(random_bytes::<4>());
        if v < zone {
            return v % n;
        }
    }
}

/// An id like `acc_3fZ…` (12 random bytes, b64url).
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", b64u(&random_bytes::<12>()))
}

// ---- trunk-kek: AES-256-GCM ---------------------------------------------------------------

/// The key-encryption key every `*_enc` column is sealed under.
pub struct Kek {
    key: LessSafeKey,
    raw: [u8; 32],
}

impl Kek {
    pub fn from_bytes(raw: [u8; 32]) -> Kek {
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &raw).expect("aes-256-gcm key"));
        Kek { key, raw }
    }

    /// `trunk-kek` file: 32 raw bytes, or 32 bytes as base64 / b64url text.
    pub fn load(path: &str) -> Result<Kek, String> {
        let b = std::fs::read(path).map_err(|e| format!("trunk-kek {path}: {e} (create one: bifrost-net trunk-kek {path})"))?;
        let raw: Vec<u8> = if b.len() == 32 {
            b
        } else {
            let t = String::from_utf8_lossy(&b).trim().to_string();
            unb64u(&t.replace('+', "-").replace('/', "_")).ok_or("trunk-kek: not 32 bytes nor base64 text")?
        };
        let arr: [u8; 32] = raw.try_into().map_err(|_| "trunk-kek must hold exactly 32 bytes")?;
        Ok(Kek::from_bytes(arr))
    }

    /// Create a fresh kek file (mode 0600) if it does not exist yet; never overwrites.
    pub fn create_file(path: &str) -> Result<bool, String> {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        if std::path::Path::new(path).exists() {
            return Ok(false);
        }
        if let Some(d) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("{path}: {e}"))?;
        f.write_all(format!("{}\n", b64u(&random_bytes::<32>())).as_bytes()).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// nonce(12) ‖ ciphertext ‖ tag(16). `aad` binds the blob to its place (e.g. "totp:acc_…").
    pub fn seal(&self, aad: &str, plain: &[u8]) -> Vec<u8> {
        let n = random_bytes::<NONCE_LEN>();
        let mut buf = plain.to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(n), Aad::from(aad.as_bytes()), &mut buf)
            .expect("aes-gcm seal");
        let mut out = n.to_vec();
        out.extend_from_slice(&buf);
        out
    }

    pub fn open(&self, aad: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
        if blob.len() < NONCE_LEN + 16 {
            return Err("sealed blob too short".into());
        }
        let n: [u8; NONCE_LEN] = blob[..NONCE_LEN].try_into().unwrap();
        let mut buf = blob[NONCE_LEN..].to_vec();
        let plain = self
            .key
            .open_in_place(Nonce::assume_unique_for_key(n), Aad::from(aad.as_bytes()), &mut buf)
            .map_err(|_| "sealed blob does not open under this trunk-kek".to_string())?;
        Ok(plain.to_vec())
    }

    /// HMAC-SHA256 (hex) under a kek-derived key: the at-rest form of a low-entropy secret (claim
    /// codes, recovery codes) — a copy of the db alone cannot brute-force it.
    pub fn pepper(&self, label: &str, data: &[u8]) -> String {
        let k = self.derive(&format!("pepper:{label}"));
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &k.raw);
        hex(ring::hmac::sign(&key, data).as_ref())
    }

    /// A key for another purpose, derived from the kek (sha256 over a label and the kek).
    pub fn derive(&self, label: &str) -> Kek {
        let mut h = Sha256::new();
        h.update(b"ygg-trunk-v1/kek-derive\0");
        h.update(label.as_bytes());
        h.update([0]);
        h.update(self.raw);
        Kek::from_bytes(h.finalize().into())
    }
}

// ---- Ed25519 -------------------------------------------------------------------------------

pub struct SigningKey {
    pair: Ed25519KeyPair,
    seed: [u8; 32],
}

impl SigningKey {
    pub fn generate() -> SigningKey {
        SigningKey::from_seed(random_bytes::<32>())
    }

    pub fn from_seed(seed: [u8; 32]) -> SigningKey {
        SigningKey { pair: Ed25519KeyPair::from_seed_unchecked(&seed).expect("ed25519 seed"), seed }
    }

    pub fn seed(&self) -> &[u8; 32] {
        &self.seed
    }

    pub fn public(&self) -> [u8; 32] {
        self.pair.public_key().as_ref().try_into().expect("ed25519 public key is 32 bytes")
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.pair.sign(msg).as_ref().try_into().expect("ed25519 signature is 64 bytes")
    }

    /// `k_` + the first 16 b64url chars of sha256(public key) (C3 footer).
    pub fn kid(&self) -> String {
        kid_of(&self.public())
    }
}

pub fn kid_of(public: &[u8]) -> String {
    format!("k_{}", &b64u(&sha256(public))[..16])
}

pub fn ed25519_verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    public.len() == 32 && sig.len() == 64 && UnparsedPublicKey::new(&ED25519, public).verify(msg, sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_round_trip_and_aad_binding() {
        let k = Kek::from_bytes([7u8; 32]);
        let blob = k.seal("totp:acc_1", b"seed bytes");
        assert_eq!(k.open("totp:acc_1", &blob).unwrap(), b"seed bytes");
        assert!(k.open("totp:acc_2", &blob).is_err(), "aad binds the blob to its row");
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(k.open("totp:acc_1", &bad).is_err(), "a flipped bit is refused");
        assert!(Kek::from_bytes([8u8; 32]).open("totp:acc_1", &blob).is_err(), "another kek cannot open it");
    }

    #[test]
    fn kek_file_formats() {
        let dir = std::env::temp_dir().join(format!("kek-{}", b64u(&random_bytes::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trunk-kek");
        let ps = p.to_str().unwrap();
        assert!(Kek::create_file(ps).unwrap());
        assert!(!Kek::create_file(ps).unwrap(), "never overwrites");
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let k = Kek::load(ps).unwrap();
        let blob = k.seal("a", b"x");
        assert_eq!(Kek::load(ps).unwrap().open("a", &blob).unwrap(), b"x");
        std::fs::write(&p, [1u8; 32]).unwrap();
        assert!(Kek::load(ps).is_ok(), "32 raw bytes");
        std::fs::write(&p, b"short").unwrap();
        assert!(Kek::load(ps).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ed25519_sign_verify_and_kid() {
        let k = SigningKey::generate();
        let sig = k.sign(b"msg");
        assert!(ed25519_verify(&k.public(), b"msg", &sig));
        assert!(!ed25519_verify(&k.public(), b"msg2", &sig));
        assert!(k.kid().starts_with("k_") && k.kid().len() == 18);
        let again = SigningKey::from_seed(*k.seed());
        assert_eq!(again.public(), k.public());
    }

    #[test]
    fn constant_time_eq() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    #[test]
    fn secrets_and_ids() {
        let s = secret("bfnr-", 32);
        assert!(s.starts_with("bfnr-") && s.len() == 5 + 43);
        assert_ne!(secret("x", 16), secret("x", 16));
        assert!(new_id("acc").starts_with("acc_"));
        for _ in 0..1000 {
            assert!(random_below(1_000_000) < 1_000_000);
        }
    }
}
