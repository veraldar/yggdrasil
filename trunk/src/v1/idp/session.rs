//! Devices and their credentials (spec §5.4, §6; lifted from `branch/lib/devices.ts`): the
//! PASETO access token (15 min, region-bound), the `bfnr-` refresh token (30 d, sha256 at rest,
//! rotated on every use, 30 s grace for two tabs racing, a replay past the grace = theft → the
//! device is revoked), step-up freshness (`last_2fa_at`, 600 s), sign-out.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::json;

use super::audit::Entry;
use crate::region::region_of;
use crate::v1::crypto::{b64u, new_id, random_bytes, secret, sha256_hex};
use crate::v1::db::now_ms;
use crate::v1::http::Resp;
use crate::v1::paseto::{self, fmt_time, Claims, Why};
use crate::v1::server::{Incoming, State};

pub const ACCESS_COOKIE: &str = "bifrost_device";
pub const REFRESH_COOKIE: &str = "bifrost_refresh";

pub struct Issued {
    pub access: String,
    pub refresh: String,
    /// unix seconds
    pub access_exp: i64,
    pub device: String,
}

/// "Chrome · Android" (≤ 40 chars) and the browser family, from a User-Agent.
pub fn ua_name(ua: &str) -> (String, String) {
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else if ua.contains("curl/") {
        "curl"
    } else {
        "browser"
    };
    let os = if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("CrOS") {
        "ChromeOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    let name = if os.is_empty() { browser.to_string() } else { format!("{browser} · {os}") };
    (name.chars().take(40).collect(), browser.to_string())
}

pub fn create_device(st: &State, account: &str, role: &str, via: &str, ip: IpAddr, ua: &str, two_fa: bool) -> Result<String, String> {
    let id = new_id("dev");
    let (name, family) = ua_name(ua);
    let now = now_ms();
    let region = region_of(ip);
    st.db.with(|c| {
        c.execute(
            "INSERT INTO devices (id, account_id, role, name, created_via, created_at, last_seen, first_region, last_region, last_2fa_at, ua_family)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7, ?8, ?9)",
            params![id, account, role, name, via, now, region, if two_fa { Some(now) } else { None }, family],
        )
        .map(|_| ())
    })?;
    Ok(id)
}

/// Mint a fresh access token + refresh token for a live device, from `ip`.
pub fn issue(st: &State, did: &str, ip: IpAddr) -> Result<Issued, String> {
    let row: Option<(String, String, String, Option<i64>)> = st.db.with(|c| {
        c.query_row("SELECT account_id, role, last_region, revoked_at FROM devices WHERE id = ?1", [did], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()
    })?;
    let Some((account, role, last_region, revoked)) = row else { return Err("no such device".into()) };
    if revoked.is_some() {
        return Err("device revoked".into());
    }
    let now = now_ms();
    let region = region_of(ip);
    let iat = now / 1000;
    let exp = iat + st.idp.t.access_ms / 1000;
    let claims = Claims {
        iss: st.cfg.origin(),
        sub: account,
        did: did.to_string(),
        role,
        rgn: region.clone(),
        kep: st.kill_epoch(),
        iat: fmt_time(iat),
        exp: fmt_time(exp),
        jti: b64u(&random_bytes::<16>()),
    };
    let access = paseto::mint(&st.signing_key(), &claims);
    let refresh = secret("bfnr-", 32);
    st.db.with(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "INSERT INTO refresh_tokens (hash, device_id, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![sha256_hex(refresh.as_bytes()), did, now, now + st.idp.t.refresh_ms],
        )?;
        if region != last_region {
            tx.execute("UPDATE devices SET last_region = ?1, moved_count = moved_count + 1 WHERE id = ?2", params![region, did])?;
        }
        tx.execute("UPDATE devices SET last_seen = ?1 WHERE id = ?2", params![now, did])?;
        tx.commit()
    })?;
    Ok(Issued { access, refresh, access_exp: exp, device: did.to_string() })
}

/// Both cookies (C3): the access cookie on `/`, the refresh cookie on `/t/auth` only. They live as
/// long as the refresh token, so an expired access token is still presented (→ `expired` →
/// refresh) instead of vanishing (→ `missing` → sign in).
pub fn set_cookies(st: &State, r: Resp, i: &Issued) -> Resp {
    let age = st.idp.t.refresh_ms / 1000;
    r.cookie(ACCESS_COOKIE, &i.access, "/", age).cookie(REFRESH_COOKIE, &i.refresh, "/t/auth", age)
}

pub fn clear_cookies(r: Resp) -> Resp {
    r.cookie(ACCESS_COOKIE, "", "/", 0).cookie(REFRESH_COOKIE, "", "/t/auth", 0)
}

/// Retire every live refresh token of a device (sign-out, revoke, theft).
fn burn_lineage(c: &rusqlite::Connection, did: &str, now: i64) -> rusqlite::Result<usize> {
    c.execute("UPDATE refresh_tokens SET retired_at = ?1 WHERE device_id = ?2 AND retired_at IS NULL", params![now, did])
}

pub fn revoke_device(st: &State, did: &str, by: Option<&str>, why: &str, ip: Option<IpAddr>) -> bool {
    let now = now_ms();
    let n = st
        .db
        .with(|c| {
            let tx = c.transaction()?;
            let n = tx.execute(
                "UPDATE devices SET revoked_at = ?1, revoked_by = ?2, revoked_why = ?3 WHERE id = ?4 AND revoked_at IS NULL",
                params![now, by, why, did],
            )?;
            burn_lineage(&tx, did, now)?;
            tx.commit()?;
            Ok(n)
        })
        .unwrap_or(0);
    if n > 0 {
        let account: Option<String> =
            st.db.with(|c| c.query_row("SELECT account_id FROM devices WHERE id = ?1", [did], |r| r.get(0)).optional()).ok().flatten();
        let mut e = Entry::new("device.revoke").target("device", did).detail(json!({ "why": why }));
        if let Some(a) = account {
            e = e.account(&a);
        }
        if let Some(b) = by {
            e = e.device(b);
        }
        if let Some(ip) = ip {
            e = e.ip(ip);
        }
        super::audit(st, e);
    }
    n > 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshErr {
    Missing,
    Invalid,
    Revoked,
    Expired,
    Region,
    /// a replaced token presented past the grace: the device was just revoked
    Theft,
}

impl RefreshErr {
    pub fn resp(self) -> Resp {
        let why = match self {
            RefreshErr::Missing => "missing",
            RefreshErr::Invalid => "invalid",
            RefreshErr::Revoked | RefreshErr::Theft => "revoked",
            RefreshErr::Expired => "expired",
            RefreshErr::Region => "region",
        };
        // a dead refresh token always means: sign in again
        clear_cookies(Resp::json(401, &json!({ "why": why, "reauth": "login" })))
    }
}

/// POST /t/auth/refresh: rotate. The old token is retired (replaced_by = the new one); a retired
/// token presented again within the grace is two tabs racing (rotate again, the newest cookie
/// wins); past the grace it is the theft signal.
pub fn refresh(st: &State, raw: Option<&str>, ip: IpAddr) -> Result<Issued, RefreshErr> {
    let raw = raw.unwrap_or("");
    if raw.len() < 16 {
        return Err(RefreshErr::Missing);
    }
    let h = sha256_hex(raw.as_bytes());
    let now = now_ms();
    let row: Option<(String, i64, Option<i64>)> = st
        .db
        .with(|c| c.query_row("SELECT device_id, expires_at, retired_at FROM refresh_tokens WHERE hash = ?1", [&h], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())
        .ok()
        .flatten();
    let Some((did, expires, retired)) = row else { return Err(RefreshErr::Invalid) };
    let dev: Option<(Option<i64>, String)> = st
        .db
        .with(|c| c.query_row("SELECT revoked_at, first_region FROM devices WHERE id = ?1", [&did], |r| Ok((r.get(0)?, r.get(1)?))).optional())
        .ok()
        .flatten();
    let Some((revoked, first_region)) = dev else { return Err(RefreshErr::Invalid) };
    if revoked.is_some() {
        return Err(RefreshErr::Revoked);
    }
    if let Some(at) = retired {
        if now - at > st.idp.t.rotate_grace_ms {
            revoke_device(st, &did, None, "refresh token replayed (theft signal)", Some(ip));
            return Err(RefreshErr::Theft);
        }
        // benign race: fall through and rotate again
    }
    if expires < now {
        return Err(RefreshErr::Expired);
    }
    if st.cfg.auth.region_policy == "repair" && region_of(ip) != first_region {
        return Err(RefreshErr::Region);
    }
    let issued = issue(st, &did, ip).map_err(|_| RefreshErr::Revoked)?;
    let nh = sha256_hex(issued.refresh.as_bytes());
    let _ = st.db.with(|c| {
        c.execute(
            "UPDATE refresh_tokens SET retired_at = ?1, replaced_by = ?2 WHERE device_id = ?3 AND retired_at IS NULL AND hash != ?2",
            params![now, nh, did],
        )
    });
    Ok(issued)
}

/// Refresh rows past their expiry are dead either way.
pub fn prune_refresh(st: &State, now: i64) {
    let _ = st.db.with(|c| c.execute("DELETE FROM refresh_tokens WHERE expires_at < ?1", [now]));
}

/// The signed-in device behind a request.
#[derive(Debug, Clone)]
pub struct Who {
    pub claims: Claims,
    pub account: String,
    pub email: Option<String>,
    pub did: String,
    pub role: String,
    pub name: String,
    pub created_via: String,
    pub created_at: i64,
    pub last_2fa_at: Option<i64>,
}

impl Who {
    pub fn fresh_until(&self, st: &State) -> Option<i64> {
        self.last_2fa_at.map(|t| t + st.idp.t.fresh_ms).filter(|u| *u > now_ms())
    }
    pub fn fresh(&self, st: &State) -> bool {
        self.fresh_until(st).is_some()
    }
    pub fn view(&self, st: &State) -> serde_json::Value {
        json!({
            "id": self.did, "name": self.name, "role": self.role, "created_via": self.created_via,
            "created_at": self.created_at, "last_2fa_at": self.last_2fa_at,
            "fresh": self.fresh(st), "fresh_until": self.fresh_until(st),
        })
    }
}

pub fn deny(why: Why) -> Resp {
    Resp::json(401, &json!({ "why": why.as_str(), "reauth": why.reauth() }))
}

/// C3 on the request, then the device and account rows.
pub fn who(st: &State, inc: &Incoming) -> Result<Who, Resp> {
    let claims = st.check_access(&inc.req, inc.ip).map_err(deny)?;
    let row: Option<(String, String, String, i64, Option<i64>, Option<String>)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT d.role, d.name, d.created_via, d.created_at, d.last_2fa_at, a.email FROM devices d JOIN accounts a ON a.id = d.account_id
                 WHERE d.id = ?1 AND d.revoked_at IS NULL AND a.status = 'active'",
                [&claims.did],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((role, name, created_via, created_at, last_2fa_at, email)) = row else { return Err(deny(Why::Revoked)) };
    Ok(Who { account: claims.sub.clone(), did: claims.did.clone(), claims, email, role, name, created_via, created_at, last_2fa_at })
}

pub fn step_up_needed() -> Resp {
    Resp::json(403, &json!({ "error": "confirm with your authenticator first", "why": "step-up", "step_up": true }))
}

pub fn mark_2fa(st: &State, did: &str) {
    let _ = st.db.with(|c| c.execute("UPDATE devices SET last_2fa_at = ?1 WHERE id = ?2", params![now_ms(), did]));
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::v1::config::Config;
    use crate::v1::crypto::Kek;
    use crate::v1::db::Db;

    /// A trunk State on an in-memory db, its files under a fresh temp dir.
    pub fn test_state(fast: bool) -> (State, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("st-{}", crate::v1::crypto::new_id("t")));
        std::fs::create_dir_all(dir.join("cred")).unwrap();
        let d = dir.to_str().unwrap();
        let raw = format!(
            "public_url = \"https://ljoolq.veraldar.org\"\nlisten_http = \"127.0.0.1:0\"\ndb = \"{d}/trunk.db\"\nstate_dir = \"{d}\"\ncred_dir = \"{d}/cred\"\nctl_socket = \"{d}/cred/ctl.sock\"\n"
        );
        let cfg = Config::parse(&raw).unwrap();
        let mut st = State::with(cfg, Db::memory(), Kek::from_bytes([3u8; 32])).unwrap();
        st.idp = super::super::Idp::new(fast);
        (st, dir)
    }

    fn account(st: &State) -> String {
        st.db
            .with(|c| c.execute("INSERT INTO accounts (id, email, pw_hash, role, created_at) VALUES ('acc_t', 'o@example.org', 'x', 'admin', 0)", []))
            .unwrap();
        "acc_t".into()
    }

    fn revoked(st: &State, did: &str) -> bool {
        st.db.with(|c| c.query_row("SELECT revoked_at FROM devices WHERE id = ?1", [did], |r| r.get::<_, Option<i64>>(0))).unwrap().is_some()
    }

    #[test]
    fn refresh_rotates_and_a_replay_past_the_grace_revokes_the_device() {
        let (st, dir) = test_state(false);
        let acc = account(&st);
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let did = create_device(&st, &acc, "admin", "login", ip, "Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130 Mobile Safari/537.36", true).unwrap();
        let first = issue(&st, &did, ip).unwrap();
        // rotate: a new pair, the old refresh token is retired
        let second = refresh(&st, Some(&first.refresh), ip).ok().unwrap();
        assert_ne!(second.refresh, first.refresh);
        // within the grace (two tabs racing): rotate again, no revoke
        let third = refresh(&st, Some(&first.refresh), ip).ok().unwrap();
        assert!(!revoked(&st, &did));
        // the replaced token presented after the grace: theft → the device is revoked
        st.db.with(|c| c.execute("UPDATE refresh_tokens SET retired_at = retired_at - 31000 WHERE hash = ?1", [sha256_hex(first.refresh.as_bytes())])).unwrap();
        assert_eq!(refresh(&st, Some(&first.refresh), ip).err(), Some(RefreshErr::Theft));
        assert!(revoked(&st, &did));
        // the thief's and the owner's newest tokens are both dead now
        assert_eq!(refresh(&st, Some(&third.refresh), ip).err(), Some(RefreshErr::Revoked));
        assert_eq!(refresh(&st, Some(&second.refresh), ip).err(), Some(RefreshErr::Revoked));
        // and the access token is refused by the C3 check (device denied)
        assert!(st.device_denied(&did));
        let last: Vec<serde_json::Value> = super::super::audit::tail(&st.db, 1);
        assert_eq!(last[0]["action"], "device.revoke");
        assert_eq!(last[0]["detail"]["why"], "refresh token replayed (theft signal)");
        assert_eq!(refresh(&st, Some("bfnr-nonsense-nonsense"), ip).err(), Some(RefreshErr::Invalid));
        assert_eq!(refresh(&st, None, ip).err(), Some(RefreshErr::Missing));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn access_token_is_region_bound_and_carries_the_kill_epoch() {
        let (st, dir) = test_state(false);
        let acc = account(&st);
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let did = create_device(&st, &acc, "admin", "login", ip, "", true).unwrap();
        let i = issue(&st, &did, ip).unwrap();
        let req = crate::v1::http::parse_head(format!("GET /t/me HTTP/1.1\r\nCookie: bifrost_device={}\r\n\r\n", i.access).as_bytes()).unwrap();
        let c = st.check_access(&req, ip).unwrap();
        assert_eq!((c.did.as_str(), c.role.as_str(), c.kep, c.rgn.as_str()), (did.as_str(), "admin", 0, "net:203.0.0.0/16"));
        assert_eq!(st.check_access(&req, "198.51.100.1".parse().unwrap()).err(), Some(Why::Region));
        st.db.meta_set("kill_epoch", "1").unwrap();
        assert_eq!(st.check_access(&req, ip).err(), Some(Why::Revoked));
        st.db.meta_set("kill_epoch", "0").unwrap();
        revoke_device(&st, &did, None, "test", None);
        assert_eq!(st.check_access(&req, ip).err(), Some(Why::Revoked));
        // a refresh from a new region (policy "refresh") is fine and moves the device
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn region_policy_refresh_moves_and_repair_refuses() {
        for policy in ["refresh", "repair"] {
            let (mut st, dir) = test_state(false);
            st.cfg.auth.region_policy = policy.into();
            let acc = account(&st);
            let home: IpAddr = "203.0.113.5".parse().unwrap();
            let away: IpAddr = "198.51.100.7".parse().unwrap();
            let did = create_device(&st, &acc, "admin", "login", home, "", true).unwrap();
            let i = issue(&st, &did, home).unwrap();
            let r = refresh(&st, Some(&i.refresh), away);
            if policy == "refresh" {
                assert!(r.is_ok());
                let moved: i64 = st.db.with(|c| c.query_row("SELECT moved_count FROM devices WHERE id = ?1", [&did], |r| r.get(0))).unwrap();
                assert_eq!(moved, 1);
            } else {
                assert_eq!(r.err(), Some(RefreshErr::Region));
            }
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn device_names() {
        assert_eq!(ua_name("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36").0, "Chrome · Android");
        assert_eq!(ua_name("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1").0, "Safari · iOS");
        assert_eq!(ua_name("curl/8.0").0, "curl");
    }
}
