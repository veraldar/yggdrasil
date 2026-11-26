//! One-use, short-lived ceremony state (`auth_challenges`, migration 002) for OAuth and passkeys.
//!
//! The browser holds a random handle (the OAuth `state`, a passkey challenge id); the table keeps
//! its sha256, the kind, who it belongs to, and the ceremony's state sealed under trunk-kek. `take`
//! deletes the row in the same statement that reads it, so a handle works once — whatever the
//! outcome — and two racing requests cannot both use it. Anyone may start a ceremony, so live rows
//! are capped per network (a flood from one network answers 429, it never evicts someone else's
//! flow) and in total: a full store makes room by dropping the oldest row of the network holding
//! the most, so a quiet network (the owner's) still gets in while a spread-out flood fights itself.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::limits::net_of;
use crate::v1::crypto::{b64u, random_bytes, sha256_hex};
use crate::v1::db::now_ms;
use crate::v1::server::State;

/// Live ceremonies one /24 (or /48) may hold at once.
pub const PER_NET: i64 = 16;
/// Live ceremonies in total (a row is ~0.5 KB; a flood needs 256 networks to reach it).
pub const TOTAL: i64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    OAuth,
    PasskeyRegister,
    PasskeyLogin,
    PasskeyStepUp,
    PasskeyMfa,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::OAuth => "oauth",
            Kind::PasskeyRegister => "passkey.register",
            Kind::PasskeyLogin => "passkey.login",
            Kind::PasskeyStepUp => "passkey.step_up",
            Kind::PasskeyMfa => "passkey.mfa",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutErr {
    Busy,
    Db(String),
}

/// A ceremony taken back (the row is gone).
#[derive(Debug, Clone)]
pub struct Taken {
    pub kind: String,
    pub account: Option<String>,
    pub device: Option<String>,
    pub data: Value,
}

fn aad(id_hash: &str, kind: &str) -> String {
    format!("challenge:{kind}:{id_hash}")
}

/// Store a ceremony; returns the handle for the browser (b64url, 32 random bytes).
pub fn put(st: &State, kind: Kind, account: Option<&str>, device: Option<&str>, ip: IpAddr, ttl_ms: i64, data: &Value) -> Result<String, PutErr> {
    let handle = b64u(&random_bytes::<32>());
    let h = sha256_hex(handle.as_bytes());
    let now = now_ms();
    let net = net_of(ip);
    let blob = st.kek.seal(&aad(&h, kind.as_str()), data.to_string().as_bytes());
    let r = st.db.with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM auth_challenges WHERE expires_at <= ?1", [now])?;
        let in_net: i64 = tx.query_row("SELECT count(*) FROM auth_challenges WHERE net = ?1", [&net], |r| r.get(0))?;
        if in_net >= PER_NET {
            return Ok(false);
        }
        let total: i64 = tx.query_row("SELECT count(*) FROM auth_challenges", [], |r| r.get(0))?;
        if total >= TOTAL {
            tx.execute(
                "DELETE FROM auth_challenges WHERE id_hash = (SELECT id_hash FROM auth_challenges
                   WHERE net = (SELECT net FROM auth_challenges GROUP BY net ORDER BY count(*) DESC, min(created_at) LIMIT 1)
                   ORDER BY created_at LIMIT 1)",
                [],
            )?;
        }
        tx.execute(
            "INSERT INTO auth_challenges (id_hash, kind, account_id, device_id, net, data_enc, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![h, kind.as_str(), account, device, net, blob, now, now + ttl_ms],
        )?;
        tx.commit()?;
        Ok(true)
    });
    match r {
        Ok(true) => Ok(handle),
        Ok(false) => Err(PutErr::Busy),
        Err(e) => Err(PutErr::Db(e)),
    }
}

/// Take a ceremony back by its handle: deleted whatever happens next. None = unknown, used,
/// expired, or not of `kind`.
pub fn take(st: &State, handle: &str, kind: Kind) -> Option<Taken> {
    if handle.is_empty() || handle.len() > 128 {
        return None;
    }
    let h = sha256_hex(handle.as_bytes());
    let now = now_ms();
    let row: Option<(String, Option<String>, Option<String>, Vec<u8>, i64)> = st
        .db
        .with(|c| {
            c.query_row(
                "DELETE FROM auth_challenges WHERE id_hash = ?1 RETURNING kind, account_id, device_id, data_enc, expires_at",
                [&h],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let (k, account, device, blob, expires) = row?;
    if k != kind.as_str() || expires <= now {
        return None;
    }
    let plain = st.kek.open(&aad(&h, &k), &blob).ok()?;
    let data: Value = serde_json::from_slice(&plain).ok()?;
    Some(Taken { kind: k, account, device, data })
}

/// Expired rows (the background tick).
pub fn prune(st: &State, now: i64) {
    let _ = st.db.with(|c| c.execute("DELETE FROM auth_challenges WHERE expires_at <= ?1", [now]));
}

/// Live rows (tests, `trunk-ctl state`).
pub fn live(st: &State) -> i64 {
    st.db.with(|c| c.query_row("SELECT count(*) FROM auth_challenges WHERE expires_at > ?1", [now_ms()], |r| r.get(0))).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::idp::session::tests::test_state;
    use serde_json::json;

    #[test]
    fn a_handle_works_once_and_only_for_its_kind() {
        let (st, dir) = test_state(true);
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        let h = put(&st, Kind::OAuth, None, None, ip, 60_000, &json!({ "verifier": "v", "nonce": "n" })).unwrap();
        assert_eq!(h.len(), 43);
        // the db holds neither the handle nor the state in clear
        let (idh, blob): (String, Vec<u8>) = st.db.with(|c| c.query_row("SELECT id_hash, data_enc FROM auth_challenges", [], |r| Ok((r.get(0)?, r.get(1)?)))).unwrap();
        assert_ne!(idh, h);
        assert!(!String::from_utf8_lossy(&blob).contains("verifier"));
        let t = take(&st, &h, Kind::OAuth).unwrap();
        assert_eq!(t.data["nonce"], "n");
        assert!(take(&st, &h, Kind::OAuth).is_none(), "second use");
        // a handle of another kind is refused — and burned
        let h2 = put(&st, Kind::PasskeyStepUp, Some("acc_x"), Some("dev_x"), ip, 60_000, &json!({})).unwrap();
        assert!(take(&st, &h2, Kind::PasskeyLogin).is_none());
        assert!(take(&st, &h2, Kind::PasskeyStepUp).is_none());
        assert!(take(&st, "", Kind::OAuth).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_full_store_drops_the_busiest_networks_oldest_not_a_quiet_one() {
        let (st, dir) = test_state(true);
        let owner = put(&st, Kind::OAuth, None, None, "198.51.100.4".parse().unwrap(), 60_000, &json!({ "who": "owner" })).unwrap();
        // a spread-out flood fills the store: 16 rows from each of many networks
        let mut n = 1;
        'fill: for a in 0..=255u32 {
            for b in 0..=255u32 {
                for _ in 0..PER_NET {
                    if n >= TOTAL {
                        break 'fill;
                    }
                    put(&st, Kind::PasskeyLogin, None, None, format!("10.{a}.{b}.1").parse().unwrap(), 60_000, &json!({})).unwrap();
                    n += 1;
                }
            }
        }
        assert_eq!(live(&st), TOTAL);
        // a new network still starts; the owner's single row survived the eviction
        assert!(put(&st, Kind::OAuth, None, None, "192.0.2.1".parse().unwrap(), 60_000, &json!({})).is_ok());
        assert_eq!(live(&st), TOTAL);
        assert_eq!(take(&st, &owner, Kind::OAuth).unwrap().data["who"], "owner");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_handles_are_refused() {
        let (st, dir) = test_state(true);
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        let h = put(&st, Kind::PasskeyLogin, None, None, ip, 60_000, &json!({})).unwrap();
        st.db.with(|c| c.execute("UPDATE auth_challenges SET expires_at = ?1", [now_ms() - 1])).unwrap();
        assert!(take(&st, &h, Kind::PasskeyLogin).is_none());
        assert_eq!(live(&st), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_flood_from_one_network_is_capped_without_evicting_anyone() {
        let (st, dir) = test_state(true);
        let other: IpAddr = "198.51.100.4".parse().unwrap();
        let keep = put(&st, Kind::OAuth, None, None, other, 60_000, &json!({ "who": "owner" })).unwrap();
        for i in 0..PER_NET {
            let ip: IpAddr = format!("203.0.113.{}", i + 1).parse().unwrap();
            put(&st, Kind::PasskeyLogin, None, None, ip, 60_000, &json!({})).unwrap();
        }
        assert_eq!(put(&st, Kind::PasskeyLogin, None, None, "203.0.113.200".parse().unwrap(), 60_000, &json!({})), Err(PutErr::Busy));
        // another network still starts, and the owner's flow is intact
        assert!(put(&st, Kind::OAuth, None, None, "192.0.2.1".parse().unwrap(), 60_000, &json!({})).is_ok());
        assert_eq!(take(&st, &keep, Kind::OAuth).unwrap().data["who"], "owner");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
