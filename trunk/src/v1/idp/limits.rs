//! Persisted lockouts (spec §8), in `limits`. The *fix* for `branch/lib/ratelimit.ts` (B23): the
//! store is never cleared wholesale — at `MAX_KEYS` only idle, unlocked rows are pruned, oldest
//! first, so flooding keys can never unlock anyone.
//!
//!   password  `pw:<email hash>`     5 failures → 1 min, doubling per lockout to 1 h (reset on success)
//!   mfa       `mfa:<account>`       5 failures → 15 min (TOTP and recovery codes together)
//!   net       `net:<a.b.c.0/24|/48>` 20 failures in an hour → 429 until the hour ends

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};

use super::Timers;
use crate::v1::db::Db;

pub const MAX_KEYS: i64 = 10_000;
pub const PW_EVERY: i64 = 5;
pub const MFA_EVERY: i64 = 5;
pub const NET_PER_WINDOW: i64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Password,
    Mfa,
    Net,
}

/// /24 for IPv4, /48 for IPv6 (the audit's truncation too).
pub fn net_of(ip: IpAddr) -> String {
    match crate::v1::config::canon(ip) {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.0/24", o[0], o[1], o[2])
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])
        }
    }
}

pub fn net_key(ip: IpAddr) -> String {
    format!("net:{}", net_of(ip))
}

pub fn pw_key(email: &str) -> String {
    format!("pw:{}", &crate::v1::crypto::sha256_hex(email.trim().to_lowercase().as_bytes())[..24])
}

pub fn mfa_key(account: &str) -> String {
    format!("mfa:{account}")
}

/// Seconds until `key` unlocks (None = not locked).
pub fn locked(db: &Db, key: &str, now: i64) -> Option<i64> {
    let until: Option<i64> = db
        .with(|c| c.query_row("SELECT locked_until FROM limits WHERE key = ?1", [key], |r| r.get::<_, Option<i64>>(0)).optional())
        .ok()
        .flatten()
        .flatten();
    until.filter(|u| *u > now).map(|u| (u - now + 999) / 1000)
}

/// Count one failure; returns the seconds of the lock it started (None = not locked by it).
pub fn fail(db: &Db, key: &str, kind: Kind, t: &Timers, now: i64) -> Option<i64> {
    db.with(|c| {
        let tx = c.transaction()?;
        let row: Option<(i64, i64, i64, Option<i64>)> = tx
            .query_row("SELECT tokens, updated_at, failures, locked_until FROM limits WHERE key = ?1", [key], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        let (mut level, mut since, mut failures, mut until) = row.unwrap_or((0, now, 0, None));
        let mut started = None;
        match kind {
            Kind::Password => {
                failures += 1;
                if failures >= PW_EVERY {
                    level += 1;
                    let ms = (t.pw_lock_base_ms << (level - 1).min(20)).min(t.pw_lock_cap_ms);
                    until = Some(now + ms);
                    started = Some(ms / 1000);
                    failures = 0;
                }
                since = now;
            }
            Kind::Mfa => {
                failures += 1;
                if failures >= MFA_EVERY {
                    until = Some(now + t.mfa_lock_ms);
                    started = Some(t.mfa_lock_ms / 1000);
                    failures = 0;
                }
                since = now;
            }
            Kind::Net => {
                if now - since >= t.net_window_ms {
                    since = now;
                    failures = 0;
                }
                failures += 1;
                if failures >= NET_PER_WINDOW {
                    until = Some(since + t.net_window_ms);
                    started = Some((since + t.net_window_ms - now) / 1000);
                }
            }
        }
        tx.execute(
            "INSERT INTO limits (key, tokens, updated_at, failures, locked_until) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET tokens = ?2, updated_at = ?3, failures = ?4, locked_until = ?5",
            params![key, level, since, failures, until],
        )?;
        tx.commit()?;
        Ok(started)
    })
    .ok()
    .flatten()
}

/// A success forgets the key (the doubling starts again from 1 min).
pub fn clear(db: &Db, key: &str) {
    let _ = db.with(|c| c.execute("DELETE FROM limits WHERE key = ?1", [key]));
}

pub fn clear_prefix(db: &Db, prefix: &str) -> usize {
    db.with(|c| c.execute("DELETE FROM limits WHERE substr(key, 1, length(?1)) = ?1", [prefix])).unwrap_or(0)
}

/// Forget idle rows (no lock running, untouched for `idle_ms`); above MAX_KEYS, the oldest unlocked
/// rows go first. A running lock is never pruned.
pub fn prune(db: &Db, now: i64, idle_ms: i64) -> usize {
    db.with(|c| {
        let mut n = c.execute(
            "DELETE FROM limits WHERE (locked_until IS NULL OR locked_until <= ?1) AND updated_at < ?2",
            params![now, now - idle_ms],
        )?;
        let total: i64 = c.query_row("SELECT count(*) FROM limits", [], |r| r.get(0))?;
        if total > MAX_KEYS {
            n += c.execute(
                "DELETE FROM limits WHERE key IN (SELECT key FROM limits WHERE locked_until IS NULL OR locked_until <= ?1
                 ORDER BY updated_at LIMIT ?2)",
                params![now, total - MAX_KEYS],
            )?;
        }
        Ok(n)
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Timers {
        Timers::new(false)
    }

    #[test]
    fn password_five_then_one_minute_doubling_to_one_hour() {
        let db = Db::memory();
        let k = pw_key("Owner@Example.org");
        assert_eq!(k, pw_key(" owner@example.org"), "the email is normalized");
        let mut now = 1_000_000_000i64;
        let mut locks = vec![];
        for _round in 0..9 {
            for i in 0..5 {
                assert!(locked(&db, &k, now).is_none());
                let s = fail(&db, &k, Kind::Password, &t(), now);
                if i < 4 {
                    assert!(s.is_none());
                } else {
                    locks.push(s.unwrap());
                }
            }
            let secs = locks.last().copied().unwrap();
            assert_eq!(locked(&db, &k, now), Some(secs));
            assert!(locked(&db, &k, now + secs * 1000 - 1).is_some());
            now += secs * 1000;
            assert!(locked(&db, &k, now).is_none());
        }
        assert_eq!(locks, [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
        clear(&db, &k);
        for _ in 0..5 {
            fail(&db, &k, Kind::Password, &t(), now);
        }
        assert_eq!(locked(&db, &k, now), Some(60), "a success starts the doubling again");
    }

    #[test]
    fn mfa_five_then_fifteen_minutes() {
        let db = Db::memory();
        let k = mfa_key("acc_x");
        let now = 5_000_000i64;
        for _ in 0..4 {
            assert!(fail(&db, &k, Kind::Mfa, &t(), now).is_none());
        }
        assert_eq!(fail(&db, &k, Kind::Mfa, &t(), now), Some(900));
        assert_eq!(locked(&db, &k, now + 899_000), Some(1));
        assert!(locked(&db, &k, now + 900_000).is_none());
    }

    #[test]
    fn net_twenty_an_hour_then_429_until_the_hour_ends() {
        let db = Db::memory();
        let ip: IpAddr = "203.0.113.77".parse().unwrap();
        assert_eq!(net_key(ip), "net:203.0.113.0/24");
        assert_eq!(net_key("2a01:e0a:1:2::3".parse().unwrap()), "net:2a01:e0a:1::/48");
        let k = net_key(ip);
        let t0 = 10_000_000i64;
        for i in 0..19 {
            assert!(fail(&db, &k, Kind::Net, &t(), t0 + i * 1000).is_none());
        }
        assert!(fail(&db, &k, Kind::Net, &t(), t0 + 60_000).is_some());
        assert!(locked(&db, &k, t0 + 3_599_000).is_some());
        assert!(locked(&db, &k, t0 + 3_600_000).is_none());
        // a new window starts from zero
        assert!(fail(&db, &k, Kind::Net, &t(), t0 + 3_600_000).is_none());
    }

    #[test]
    fn no_clear_all_at_ten_thousand_keys() {
        let db = Db::memory();
        let now = 50_000_000i64;
        let victim = pw_key("owner@example.org");
        for _ in 0..5 {
            fail(&db, &victim, Kind::Password, &t(), now);
        }
        assert!(locked(&db, &victim, now).is_some());
        db.with(|c| {
            let tx = c.transaction()?;
            for i in 0..(MAX_KEYS + 500) {
                tx.execute("INSERT INTO limits (key, tokens, updated_at, failures) VALUES (?1, 0, ?2, 1)", params![format!("net:junk{i}"), now + i])?;
            }
            tx.commit()
        })
        .unwrap();
        let pruned = prune(&db, now + 1, 3_600_000);
        assert!(pruned >= 500, "pruned {pruned}");
        let total: i64 = db.with(|c| c.query_row("SELECT count(*) FROM limits", [], |r| r.get(0))).unwrap();
        assert!(total <= MAX_KEYS, "{total}");
        assert!(locked(&db, &victim, now + 1).is_some(), "flooding keys never unlocks anyone (B23 fix)");
        // idle rows go after `idle_ms`; a running lock never does
        prune(&db, now + 30_000, 1);
        assert!(locked(&db, &victim, now + 30_000).is_some());
        let left: i64 = db.with(|c| c.query_row("SELECT count(*) FROM limits", [], |r| r.get(0))).unwrap();
        assert_eq!(left, 1, "only the running lock is left");
    }
}
