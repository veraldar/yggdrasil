//! Passwords (spec §8): argon2id m=19 MiB, t=2, p=1; at most 2 hashing at once (1 vCPU);
//! 12–128 characters and not one of the embedded top-100k (case-insensitive).

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use tokio::sync::Semaphore;

use crate::v1::crypto::random_bytes;

pub const M_KIB: u32 = 19 * 1024;
pub const T_COST: u32 = 2;
pub const P_LANES: u32 = 1;
pub const MAX_PARALLEL: usize = 2;
pub const MIN_CHARS: usize = 12;
pub const MAX_CHARS: usize = 128;

static LIST: &[u8] = include_bytes!("data/common-passwords.txt.gz");

fn common() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        use std::io::Read as _;
        let mut s = String::new();
        flate2::read::GzDecoder::new(LIST).read_to_string(&mut s).expect("embedded password list");
        s.lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
    })
}

pub fn common_count() -> usize {
    common().len()
}

/// Why a new password is refused (shown to the owner as is).
pub fn policy(pw: &str, email: &str) -> Result<(), &'static str> {
    let n = pw.chars().count();
    if n < MIN_CHARS {
        return Err("use at least 12 characters");
    }
    if n > MAX_CHARS {
        return Err("use at most 128 characters");
    }
    let low = pw.to_lowercase();
    if common().contains(&low) {
        return Err("this password is on the list of the 100,000 most used ones — pick another");
    }
    if !email.is_empty() && low.trim() == email.trim().to_lowercase() {
        return Err("the password cannot be your email address");
    }
    Ok(())
}

fn argon() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(M_KIB, T_COST, P_LANES, None).expect("argon2 params"))
}

/// The hashing gate: at most two argon2 runs at once; the rest wait their turn.
pub struct Hasher {
    gate: Arc<Semaphore>,
    running: Arc<AtomicUsize>,
    /// the most that ever ran at once (tests read it)
    pub peak: Arc<AtomicUsize>,
    dummy: OnceLock<String>,
}

impl Default for Hasher {
    fn default() -> Self {
        Hasher {
            gate: Arc::new(Semaphore::new(MAX_PARALLEL)),
            running: Arc::default(),
            peak: Arc::default(),
            dummy: OnceLock::new(),
        }
    }
}

pub fn hash_sync(pw: &str) -> String {
    let salt = SaltString::encode_b64(&random_bytes::<16>()).expect("salt");
    argon().hash_password(pw.as_bytes(), &salt).expect("argon2 hash").to_string()
}

pub fn verify_sync(pw: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(h) => argon().verify_password(pw.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

impl Hasher {
    async fn gated<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> T {
        let _permit = self.gate.clone().acquire_owned().await.expect("hash gate");
        let (running, peak) = (self.running.clone(), self.peak.clone());
        tokio::task::spawn_blocking(move || {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            let out = f();
            running.fetch_sub(1, Ordering::SeqCst);
            out
        })
        .await
        .expect("hash task")
    }

    pub async fn hash(&self, pw: &str) -> String {
        let pw = pw.to_string();
        self.gated(move || hash_sync(&pw)).await
    }

    pub async fn verify(&self, pw: &str, stored: &str) -> bool {
        let (pw, stored) = (pw.to_string(), stored.to_string());
        self.gated(move || verify_sync(&pw, &stored)).await
    }

    /// The same work as a real check, for an email that has no account (generic errors, same time).
    pub async fn verify_dummy(&self, pw: &str) -> bool {
        let stored = self.dummy.get_or_init(|| hash_sync(&crate::v1::crypto::secret("", 24))).clone();
        let _ = self.verify(pw, &stored).await;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_rules() {
        assert!(policy("short", "").is_err());
        assert!(policy(&"x".repeat(129), "").is_err());
        assert!(policy(&"é".repeat(12), "").is_ok(), "characters, not bytes");
        assert!(policy("correct horse battery staple", "").is_ok());
        assert!(common_count() > 90_000, "the top-100k list is embedded ({})", common_count());
        // on the list (any case)
        assert!(policy("000000000000", "").is_err());
        assert!(policy("QWERTYUIOPASDFGHJKL", "").is_err() || !common().contains("qwertyuiopasdfghjkl"));
        assert!(policy("owner@example.org", "owner@example.org").is_err());
    }

    #[test]
    fn argon2id_with_the_spec_parameters() {
        let h = hash_sync("correct horse battery staple");
        assert!(h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{h}");
        assert!(verify_sync("correct horse battery staple", &h));
        assert!(!verify_sync("correct horse battery stapler", &h));
        assert!(!verify_sync("x", "not a hash"));
    }

    #[test]
    fn at_most_two_hash_at_once() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
        rt.block_on(async {
            let h = Arc::new(Hasher::default());
            let mut v = vec![];
            for i in 0..6 {
                let h = h.clone();
                v.push(tokio::spawn(async move { h.hash(&format!("password number {i}")).await }));
            }
            for j in v {
                assert!(j.await.unwrap().starts_with("$argon2id$"));
            }
            assert_eq!(h.peak.load(Ordering::SeqCst), MAX_PARALLEL, "six at once never run more than two");
        });
    }
}
