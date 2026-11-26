//! `trunk-state.json` (CONTRACTS.md C5): what a root knows from its trunk.
//!
//! The bridge is the only writer: atomic rename, mode 0600, rewritten on every change and at
//! least every 10 s (`link.written` says when — the v1 health check wants it < 30 s old). The
//! readers: the app (`BIFROST_TRUNK_STATE`), `bifrost-net wg` (the signed directory → its peers),
//! the brain through the wg node's `/_wg/_roots` (per-root peer token hashes), `hub-units.sh`.
//!
//! The access-token check every verifier runs (C3), in this order and with these words:
//! signature with a non-retired `kid` → `invalid`; `exp` passed → `expired`; `rgn` ≠ the region of
//! the request's real client address → `region`; `kep` < `kill_epoch` → `revoked`; `did` in
//! `deny[]` → `revoked`; no token → `missing`.
//!
//! Pure std (no runtime): the root build's wg node reads this file too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::proto;

/// How often the file is rewritten when nothing changed (C5: at least every 10 s).
pub const REWRITE_EVERY: Duration = Duration::from_secs(10);

/// The origin of an url, lowercased ("https://host[:port]").
pub fn origin_of(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("https", url));
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return format!("https://{rest}");
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest).to_ascii_lowercase();
    format!("{scheme}://{host}")
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TrunkInfo {
    pub url: String,
    pub trunk_id: String,
    pub trunk_key: String,
    /// every origin a valid token's `iss` may be (public_url + https://extra_name, as the trunk
    /// mints); empty in an old file → backfilled from `url`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issuers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RootInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LinkInfo {
    /// `up`, `down`, `connecting`, `revoked`
    pub state: String,
    pub since: u64,
    pub written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Key {
    pub kid: String,
    pub alg: String,
    pub public: String,
    pub retired_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DenyEntry {
    pub did: String,
    pub until: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StateFile {
    pub version: u64,
    pub trunk: TrunkInfo,
    pub root: RootInfo,
    pub link: LinkInfo,
    pub keys: Vec<Key>,
    pub kill_epoch: u64,
    pub lockdown: bool,
    pub deny: Vec<DenyEntry>,
    /// the trunk-signed directory as received (`{seq, issued_at, sig, roots}`), or null
    pub directory: Value,
    pub vapid_public: Option<String>,
}

impl StateFile {
    pub fn new(url: &str, trunk_key: &str, root_id: &str) -> StateFile {
        StateFile {
            version: 1,
            trunk: TrunkInfo { url: url.into(), trunk_id: String::new(), trunk_key: trunk_key.into(), issuers: vec![origin_of(url)] },
            root: RootInfo { id: root_id.into(), name: String::new() },
            link: LinkInfo { state: "down".into(), since: now_ms(), written: 0 },
            keys: vec![],
            kill_epoch: 0,
            lockdown: false,
            deny: vec![],
            directory: Value::Null,
            vapid_public: None,
        }
    }

    pub fn read(path: &Path) -> Option<StateFile> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }

    /// The public key of a non-retired `kid` (C3).
    pub fn key_for(&self, kid: &str, now: u64) -> Option<[u8; 32]> {
        self.keys
            .iter()
            .find(|k| k.kid == kid && k.alg == "ed25519" && k.retired_at.is_none_or(|t| t > now))
            .and_then(|k| proto::public_from_b64u(&k.public))
            .filter(|p| proto::kid_of(p) == kid)
    }

    pub fn denied(&self, did: &str, now: u64) -> bool {
        self.deny.iter().any(|d| d.did == did && d.until > now)
    }

    /// The verified directory: (seq, roots). None = none yet, or its signature fails.
    pub fn directory_roots(&self, trunk_key: &[u8]) -> Option<(u64, Vec<proto::DirRoot>)> {
        if self.directory.is_null() {
            return None;
        }
        proto::verify_directory(trunk_key, &self.directory)
    }
}

/// Why a token is refused (C3 words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Missing,
    Invalid,
    Expired,
    Region,
    Revoked,
}

impl Why {
    pub fn word(self) -> &'static str {
        match self {
            Why::Missing => "missing",
            Why::Invalid => "invalid",
            Why::Expired => "expired",
            Why::Region => "region",
            Why::Revoked => "revoked",
        }
    }
    /// C3: `expired`/`region` → refresh, everything else → login.
    pub fn reauth(self) -> &'static str {
        match self {
            Why::Expired | Why::Region => "refresh",
            _ => "login",
        }
    }
}

/// A token that passed every check.
#[derive(Debug, Clone, PartialEq)]
pub struct Claims {
    pub sub: String,
    pub did: String,
    pub role: String,
    pub rgn: String,
    pub kep: u64,
    pub exp_ms: u64,
}

/// The token's device and expiry after the signature check only (the meter names the device of a
/// refused token; nothing else trusts this).
pub fn signed_claims(st: &StateFile, raw: &str, now: u64) -> Option<(Value, u64)> {
    let (claims, _) = proto::paseto_v4_verify(raw, |footer| {
        let f = serde_json::from_slice::<Value>(footer).ok()?;
        let o = f.as_object().filter(|o| o.len() == 1)?; // the footer is exactly {"kid"}
        st.key_for(o.get("kid")?.as_str()?, now)
    })?;
    // C3: exactly these keys, second-precision UTC times
    const KEYS: [&str; 9] = ["iss", "sub", "did", "role", "rgn", "kep", "iat", "exp", "jti"];
    let o = claims.as_object()?;
    if o.len() != KEYS.len() || !KEYS.iter().all(|k| o.contains_key(*k)) {
        return None;
    }
    let time = |k: &str| claims[k].as_str().filter(|t| t.len() == 20).and_then(proto::parse_rfc3339);
    time("iat")?;
    let exp = time("exp")?;
    Some((claims, exp))
}

/// The C3 check, in its order. `region` = the region of the request's real client address.
pub fn check_token(st: &StateFile, raw: &str, region: &str, now: u64) -> Result<Claims, Why> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(Why::Missing);
    }
    let Some((c, exp_ms)) = signed_claims(st, raw, now) else { return Err(Why::Invalid) };
    let s = |k: &str| c[k].as_str().map(str::to_string);
    let (Some(sub), Some(did), Some(role), Some(rgn), Some(kep)) = (s("sub"), s("did"), s("role"), s("rgn"), c["kep"].as_u64()) else {
        return Err(Why::Invalid);
    };
    // the trunk's own origins only, and no token from the future (more than 60 s of clock skew)
    let iss = s("iss").unwrap_or_default();
    if st.trunk.issuers.is_empty() || !st.trunk.issuers.iter().any(|o| o.eq_ignore_ascii_case(&iss)) {
        return Err(Why::Invalid);
    }
    if let Some(iat) = c["iat"].as_str().filter(|t| t.len() == 20).and_then(proto::parse_rfc3339) {
        if iat > now + 60_000 {
            return Err(Why::Invalid);
        }
    } else {
        return Err(Why::Invalid);
    }
    if exp_ms <= now {
        return Err(Why::Expired);
    }
    if rgn != region {
        return Err(Why::Region);
    }
    if kep < st.kill_epoch {
        return Err(Why::Revoked);
    }
    if st.denied(&did, now) {
        return Err(Why::Revoked);
    }
    Ok(Claims { sub, did, role, rgn, kep, exp_ms })
}

/* ------------------------------------------------------------------ the shared, written state */

/// The bridge's live copy of the state, shared by the link (which changes it), the device gate
/// (which reads it) and the file writer.
pub struct TrunkState {
    pub path: Option<PathBuf>,
    inner: Mutex<(StateFile, u64)>,
    changed: Condvar,
    /// when each device was denied / when the kill epoch last moved (the meter's revoke → cut)
    pub revoked_at: Mutex<std::collections::HashMap<String, u64>>,
    pub killed_at: Mutex<Option<u64>>,
}

impl TrunkState {
    /// Start from the file when it exists and belongs to this root and trunk (so a restart keeps
    /// the keys, deny-list and directory until the link is back), else fresh.
    pub fn open(path: Option<PathBuf>, url: &str, trunk_key: &str, root_id: &str) -> Arc<TrunkState> {
        let mut st = StateFile::new(url, trunk_key, root_id);
        if let Some(old) = path.as_deref().and_then(StateFile::read) {
            if old.trunk.trunk_key == trunk_key && old.root.id == root_id {
                let mut trunk = TrunkInfo { url: url.into(), ..old.trunk.clone() };
                if trunk.issuers.is_empty() {
                    trunk.issuers = vec![origin_of(url)];
                }
                st = StateFile { link: LinkInfo { state: "down".into(), since: now_ms(), written: 0 }, trunk, ..old };
            }
        }
        Arc::new(TrunkState {
            path,
            inner: Mutex::new((st, 1)),
            changed: Condvar::new(),
            revoked_at: Mutex::default(),
            killed_at: Mutex::default(),
        })
    }

    pub fn snapshot(&self) -> StateFile {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).0.clone()
    }

    pub fn with<T>(&self, f: impl FnOnce(&StateFile) -> T) -> T {
        f(&self.inner.lock().unwrap_or_else(|e| e.into_inner()).0)
    }

    /// Change the state; the file follows at once.
    pub fn update(&self, f: impl FnOnce(&mut StateFile)) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g.0);
        g.1 += 1;
        self.changed.notify_all();
    }

    pub fn set_link(&self, state: &str) {
        self.update(|s| {
            if s.link.state != state {
                s.link.state = state.into();
                s.link.since = now_ms();
            }
        });
    }

    /// Write the file now (atomic, 0600). Expired deny entries are dropped first.
    pub fn write_now(&self) -> Result<(), String> {
        let Some(path) = self.path.clone() else { return Ok(()) };
        let text = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let now = now_ms();
            g.0.deny.retain(|d| d.until > now);
            g.0.link.written = now;
            serde_json::to_string_pretty(&g.0).map_err(|e| e.to_string())?
        };
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            let _ = std::fs::create_dir_all(dir);
        }
        proto::write_private(&path, &format!("{text}\n"))
    }

    /// The writer: on every change, and at least every REWRITE_EVERY.
    pub fn spawn_writer(self: &Arc<Self>) {
        if self.path.is_none() {
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("trunk-state".into())
            .spawn(move || {
                let mut seen = 0u64;
                loop {
                    {
                        let g = me.inner.lock().unwrap_or_else(|e| e.into_inner());
                        let (g, _) = me
                            .changed
                            .wait_timeout_while(g, REWRITE_EVERY, |g| g.1 == seen)
                            .unwrap_or_else(|e| e.into_inner());
                        seen = g.1;
                    }
                    if let Err(e) = me.write_now() {
                        eprintln!("  trunk: cannot write the state file: {e}");
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            })
            .expect("trunk-state writer");
    }

    pub fn check(&self, raw: &str, region: &str) -> Result<Claims, Why> {
        self.with(|s| check_token(s, raw, region, now_ms()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::proto::{kid_of, paseto_v4_sign, rfc3339, SignKey};
    use serde_json::json;

    fn token(k: &SignKey, did: &str, rgn: &str, kep: u64, exp: u64) -> String {
        let footer = json!({ "kid": kid_of(&k.public()) }).to_string();
        let claims = json!({ "iss": "https://t", "sub": "acc_1", "did": did, "role": "admin", "rgn": rgn, "kep": kep,
                             "iat": rfc3339(exp - 900_000), "exp": rfc3339(exp), "jti": "j" });
        paseto_v4_sign(k, &claims, footer.as_bytes())
    }

    fn state(k: &SignKey) -> StateFile {
        let mut s = StateFile::new("https://t", "tk", "rt_a");
        s.keys.push(Key { kid: kid_of(&k.public()), alg: "ed25519".into(), public: k.public_b64u(), retired_at: None });
        s
    }

    #[test]
    fn c3_order_and_words() {
        let k = SignKey::generate();
        let mut s = state(&k);
        let now = 1_764_100_000_000;
        let good = token(&k, "dev_1", "loopback", 0, now + 600_000);
        assert_eq!(check_token(&s, &good, "loopback", now).map(|c| c.did), Ok("dev_1".into()));
        assert_eq!(check_token(&s, "", "loopback", now), Err(Why::Missing));
        assert_eq!(check_token(&s, "v4.public.junk", "loopback", now), Err(Why::Invalid));
        assert_eq!(check_token(&s, &token(&SignKey::generate(), "dev_1", "loopback", 0, now + 600_000), "loopback", now), Err(Why::Invalid));
        // expired beats region beats revoked (the order)
        let old = token(&k, "dev_1", "net:1.2.0.0/16", 0, now - 1);
        assert_eq!(check_token(&s, &old, "loopback", now), Err(Why::Expired));
        assert_eq!(check_token(&s, &good, "net:1.2.0.0/16", now), Err(Why::Region));
        s.kill_epoch = 1;
        assert_eq!(check_token(&s, &good, "loopback", now), Err(Why::Revoked));
        assert_eq!(check_token(&s, &token(&k, "dev_1", "loopback", 1, now + 600_000), "loopback", now).map(|c| c.kep), Ok(1));
        s.kill_epoch = 0;
        s.deny.push(DenyEntry { did: "dev_1".into(), until: now + 1 });
        assert_eq!(check_token(&s, &good, "loopback", now), Err(Why::Revoked));
        assert_eq!(check_token(&s, &good, "loopback", now + 1).map(|c| c.did), Ok("dev_1".into()), "a deny entry lapses");
        s.deny.clear();
        // a retired kid no longer verifies
        s.keys[0].retired_at = Some(now);
        assert_eq!(check_token(&s, &good, "loopback", now), Err(Why::Invalid));
        assert_eq!(Why::Expired.reauth(), "refresh");
        assert_eq!(Why::Region.reauth(), "refresh");
        assert_eq!(Why::Revoked.reauth(), "login");
        assert_eq!(Why::Invalid.reauth(), "login");
        assert_eq!(Why::Missing.reauth(), "login");
    }

    /// CONTRACTS.md C3: the IDP's shared vectors, every case, the same answer as the trunk.
    #[test]
    fn shared_c3_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/trunk-v1/vectors/paseto.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors file")).unwrap();
        let mut base = StateFile::new("https://t", "", "");
        base.keys = serde_json::from_value(v["keys"].clone()).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 15);
        for c in cases {
            let mut st = base.clone();
            st.trunk.issuers = c["ctx"]["issuers"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            st.kill_epoch = c["ctx"]["kill_epoch"].as_u64().unwrap();
            st.deny = serde_json::from_value(c["ctx"]["deny"].clone()).unwrap();
            let now = c["ctx"]["now"].as_u64().unwrap() * 1000;
            let tok = c["token"].as_str().unwrap_or("");
            let got = check_token(&st, tok, c["ctx"]["region"].as_str().unwrap(), now);
            let e = &c["expect"];
            match got {
                Ok(cl) => {
                    assert_eq!(e["ok"], true, "{}: accepted, the trunk refuses ({e})", c["name"]);
                    assert_eq!((cl.did.as_str(), cl.role.as_str(), cl.sub.as_str()), (e["did"].as_str().unwrap(), e["role"].as_str().unwrap(), e["sub"].as_str().unwrap()), "{}", c["name"]);
                }
                Err(w) => {
                    assert_eq!((Some(w.word()), Some(w.reauth())), (e["why"].as_str(), e["reauth"].as_str()), "{}", c["name"]);
                }
            }
        }
    }

    #[test]
    fn writer_is_atomic_0600_and_periodic() {
        let dir = std::env::temp_dir().join(format!("trunk-state-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trunk-state.json");
        let st = TrunkState::open(Some(path.clone()), "https://t", "tk", "rt_a");
        st.spawn_writer();
        st.set_link("up");
        let t0 = std::time::Instant::now();
        let read = || StateFile::read(&path);
        while read().is_none_or(|s| s.link.state != "up") {
            assert!(t0.elapsed() < Duration::from_secs(2), "not written on change");
            std::thread::sleep(Duration::from_millis(10));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let s = read().unwrap();
        assert_eq!((s.version, s.root.id.as_str(), s.trunk.trunk_key.as_str()), (1, "rt_a", "tk"));
        assert!(s.link.written >= s.link.since);
        // a restart keeps what it knew (same root, same trunk), link down until it is back
        st.update(|s| s.kill_epoch = 3);
        while read().is_none_or(|s| s.kill_epoch != 3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let again = TrunkState::open(Some(path.clone()), "https://t", "tk", "rt_a");
        assert_eq!(again.snapshot().kill_epoch, 3);
        assert_eq!(again.snapshot().link.state, "down");
        let other = TrunkState::open(Some(path.clone()), "https://t", "other-key", "rt_a");
        assert_eq!(other.snapshot().kill_epoch, 0, "another trunk's state is not taken");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
