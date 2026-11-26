//! The identity authority (spec §4.1 items 1–3, §5.6 F1–F2, §8): claim, the admin account,
//! TOTP + recovery codes, sign-in, step-up, refresh rotation, lockouts, the audit chain.

pub mod account;
pub mod api;
pub mod audit;
pub mod claim;
pub mod console;
pub mod devices;
pub mod limits;
pub mod pair;
pub mod password;
pub mod qr;
pub mod session;
pub mod totp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::db::now_ms;
use super::server::State;

/// The §8 numbers. `TRUNK_TEST_FAST=1` (rigs only) shortens the waits — never the counts, the
/// hash cost or the TOTP step.
#[derive(Debug, Clone, Copy)]
pub struct Timers {
    pub claim_rotate_ms: i64,
    pub claim_overlap_ms: i64,
    pub claim_ticket_ms: i64,
    pub access_ms: i64,
    pub refresh_ms: i64,
    pub rotate_grace_ms: i64,
    pub fresh_ms: i64,
    pub mfa_ticket_ms: i64,
    pub pw_lock_base_ms: i64,
    pub pw_lock_cap_ms: i64,
    pub mfa_lock_ms: i64,
    pub net_window_ms: i64,
    pub limits_idle_ms: i64,
    pub pair_ttl_ms: i64,
    pub pair_used_keep_ms: i64,
}

impl Timers {
    pub fn new(fast: bool) -> Timers {
        let normal = Timers {
            claim_rotate_ms: 300_000,
            claim_overlap_ms: 15_000,
            claim_ticket_ms: 600_000,
            access_ms: 900_000,
            refresh_ms: 30 * 86_400_000,
            rotate_grace_ms: 30_000,
            fresh_ms: 600_000,
            mfa_ticket_ms: 300_000,
            pw_lock_base_ms: 60_000,
            pw_lock_cap_ms: 3_600_000,
            mfa_lock_ms: 900_000,
            net_window_ms: 3_600_000,
            limits_idle_ms: 86_400_000,
            pair_ttl_ms: 300_000,
            pair_used_keep_ms: 3_600_000,
        };
        if !fast {
            return normal;
        }
        // rigs: minutes become seconds (÷60); the access token lives 20 s so expiry is testable
        Timers {
            claim_rotate_ms: 5_000,
            claim_overlap_ms: 1_000,
            claim_ticket_ms: 60_000,
            access_ms: 20_000,
            rotate_grace_ms: 3_000,
            fresh_ms: 10_000,
            mfa_ticket_ms: 60_000,
            pw_lock_base_ms: 1_000,
            pw_lock_cap_ms: 60_000,
            mfa_lock_ms: 15_000,
            net_window_ms: 60_000,
            limits_idle_ms: 120_000,
            pair_ttl_ms: 15_000,
            pair_used_keep_ms: 60_000,
            ..normal
        }
    }
}

/// A first factor that passed; the second is still owed (`/t/auth/mfa`).
#[derive(Debug, Clone)]
pub struct MfaTicket {
    pub account: String,
    pub expires: i64,
    pub first: &'static str,
}

pub struct Idp {
    pub t: Timers,
    pub hasher: password::Hasher,
    pub claim: Mutex<claim::Runtime>,
    /// sha256(ticket) → pending second factor (in memory: a restart asks for the password again)
    pub mfa: Mutex<HashMap<String, MfaTicket>>,
    /// account → (seed, created) of a TOTP reset not confirmed yet
    pub totp_pending: Mutex<HashMap<String, (Vec<u8>, i64)>>,
}

impl Idp {
    pub fn new(fast: bool) -> Idp {
        Idp {
            t: Timers::new(fast),
            hasher: password::Hasher::default(),
            claim: Mutex::new(claim::Runtime::default()),
            mfa: Mutex::new(HashMap::new()),
            totp_pending: Mutex::new(HashMap::new()),
        }
    }
}

pub fn audit_dir(st: &State) -> String {
    format!("{}/audit", st.cfg.state_dir.trim_end_matches('/'))
}

/// Write an audit entry (the mirror beside the db); a failure to write is printed, never hidden.
pub fn audit(st: &State, e: audit::Entry) {
    if let Err(err) = audit::append(&st.db, Some(&audit_dir(st)), e) {
        eprintln!("  trunk: AUDIT WRITE FAILED: {err}");
    }
}

/// Timers that run for the life of the process: the claim code's rotation, lockout pruning,
/// audit retention, expired tickets.
pub fn spawn_background(st: Arc<State>) {
    claim::start(&st);
    let warm = st.clone();
    tokio::task::spawn_blocking(move || warm.idp.hasher.warm());
    tokio::spawn(async move {
        let mut last_daily = 0i64;
        let mut last_prune = 0i64;
        loop {
            let now = now_ms();
            claim::tick(&st, now);
            if now - last_prune > 60_000 {
                last_prune = now;
                limits::prune(&st.db, now, st.idp.t.limits_idle_ms);
                st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, t| t.expires > now);
                st.idp.totp_pending.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, (_, at)| now - *at < 600_000);
                session::prune_refresh(&st, now);
                pair::prune(&st, now);
            }
            if now - last_daily > 86_400_000 {
                last_daily = now;
                audit::retain(&st.db, Some(&audit_dir(&st)), now);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
}
