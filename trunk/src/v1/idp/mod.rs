//! The identity authority (spec §4.1 items 1–3, §5.6 F1–F2, §8): claim, the admin account,
//! TOTP + recovery codes, sign-in, step-up, refresh rotation, lockouts, the audit chain.

pub mod api;
pub mod console;

use std::sync::Arc;

use super::server::State;

/// The §8 numbers. `TRUNK_TEST_FAST=1` (rigs only) shortens the waits, never the counts.
#[derive(Debug, Clone, Copy)]
pub struct Timers {
    pub claim_rotate_s: i64,
}

impl Timers {
    pub fn new(fast: bool) -> Timers {
        if fast { Timers { claim_rotate_s: 20 } } else { Timers { claim_rotate_s: 300 } }
    }
}

pub struct Idp {
    pub t: Timers,
}

impl Idp {
    pub fn new(fast: bool) -> Idp {
        Idp { t: Timers::new(fast) }
    }
}

/// Timers that run for the life of the process.
pub fn spawn_background(_st: Arc<State>) {}
