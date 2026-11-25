//! `bifrost-net trunk-rig` — rig-only helpers (refused unless TRUNK_TEST_FAST=1), so the sims can
//! drive a real trunk before the IDP's sign-in is merged: seed a claimed trunk with an admin
//! device that just stepped up, and mint that device's access token (printed on stdout, never on
//! a command line). It opens the trunk's own db + kek, so only whoever already owns the trunk's
//! files can run it.

use std::sync::Arc;

use super::config::Config;
use super::db::now_ms;
use super::paseto::{self, Claims};
use super::server::State;

fn arg(args: &[String], k: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == k).map(|w| w[1].clone())
}

pub fn cmd(args: &[String]) -> i32 {
    if !std::env::var("TRUNK_TEST_FAST").is_ok_and(|v| v == "1") {
        eprintln!("trunk-rig: rigs only (TRUNK_TEST_FAST=1)");
        return 2;
    }
    let (Some(sub), Some(cfg)) = (args.first(), arg(args, "-c")) else {
        eprintln!("trunk-rig seed-admin|mint -c trunk.toml --device dev_… [--role admin|member] [--region R] [--ttl-s N]");
        return 2;
    };
    let run = || -> Result<String, String> {
        let st = Arc::new(State::open(Config::load(&cfg)?)?);
        let did = arg(args, "--device").unwrap_or_else(|| "dev_rig_admin".into());
        let role = arg(args, "--role").unwrap_or_else(|| "admin".into());
        match sub.as_str() {
            "seed-admin" => {
                let now = now_ms();
                st.db.with(|c| {
                    c.execute("INSERT OR IGNORE INTO accounts (id, email, role, created_at) VALUES ('acc_rig', 'rig@local', 'admin', ?1)", [now])?;
                    c.execute(
                        "INSERT INTO devices (id, account_id, role, name, created_via, created_at, last_seen, first_region, last_region, last_2fa_at)
                         VALUES (?1, 'acc_rig', ?2, ?1, 'login', ?3, ?3, 'loopback', 'loopback', ?3)
                         ON CONFLICT(id) DO UPDATE SET last_2fa_at = ?3, role = ?2",
                        rusqlite::params![did, role, now],
                    )?;
                    c.execute("INSERT OR IGNORE INTO meta (k, v) VALUES ('claimed_at', ?1)", [now.to_string()])?;
                    Ok(())
                })?;
                Ok(format!("seeded {did} ({role})"))
            }
            "mint" => {
                let now = now_ms() / 1000;
                let ttl: i64 = arg(args, "--ttl-s").and_then(|t| t.parse().ok()).unwrap_or(900);
                let c = Claims {
                    iss: st.cfg.origin(),
                    sub: "acc_rig".into(),
                    did,
                    role,
                    rgn: arg(args, "--region").unwrap_or_else(|| "loopback".into()),
                    kep: st.kill_epoch(),
                    iat: paseto::fmt_time(now),
                    exp: paseto::fmt_time(now + ttl),
                    jti: super::crypto::b64u(&super::crypto::random_bytes::<16>()),
                };
                Ok(paseto::mint(&st.signing_key(), &c))
            }
            other => Err(format!("unknown: {other}")),
        }
    };
    match run() {
        Ok(out) => {
            println!("{out}");
            0
        }
        Err(e) => {
            eprintln!("trunk-rig: {e}");
            1
        }
    }
}
