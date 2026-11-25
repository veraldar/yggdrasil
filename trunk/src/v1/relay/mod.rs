//! WIRE's place in the trunk (CONTRACTS.md C1/C4/C6). The skeleton routes through these four
//! hooks; the WIRE stream fills them in (proto 2 on `/t/root`, the relay to the door root, the
//! directory, ICE-TCP by registered ufrag, `/t/roots*`, `/t/me/roots`, `/t/me/door`, `/t/ice/owner`).
//!
//! Until then: no route here, no roots, and every signed-in page outside the shell lands on
//! `/offline`.

use std::sync::Arc;

use super::db::Migration;
use super::http::Resp;
use super::paseto::Claims;
use super::server::{Incoming, State};

/// WIRE's numbered migrations (100–199), merged into the runner by number.
pub const MIGRATIONS: &[Migration] = &[];

/// WIRE's in-memory state (ufrag routes, live root links …), one per trunk process.
#[derive(Default)]
pub struct Relay {}

/// First look at every request. Return `None` when this stream was answered here (`/t/root`,
/// `/t/roots*`, `/t/me/roots`, `/t/me/door`, `/t/ice/owner` …), `Some(inc)` to hand it back.
pub async fn route(_st: &Arc<State>, inc: Incoming) -> Option<Incoming> {
    Some(inc)
}

/// Does this trunk have at least one enrolled, unrevoked root? (`/t/state` `has_roots`, the
/// empty-trunk page.) Until WIRE's `roots` table exists: no.
pub fn has_roots(st: &State) -> bool {
    if !st.db.table_exists("roots") {
        return false;
    }
    st.db
        .with(|c| c.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE revoked_at IS NULL)", [], |r| r.get::<_, bool>(0)))
        .unwrap_or(false)
}

/// A request outside the trunk's own namespace from a device whose token passed the C3 checks:
/// relay it to the device's door root (P12 law: `inc.body` / `http::rewrite_head`), answering on
/// `inc.io`. Skeleton: no door yet → `/offline` (page) or 503 (anything else).
pub async fn to_door(_st: &Arc<State>, inc: Incoming, _who: Claims) {
    let r: Resp = super::shell::offline_for(&inc.req);
    inc.answer(r).await
}

/// `listen_ice` (phase 2): framed STUN / ICE-TCP routed by registered ufrag (§5.7).
pub async fn serve_ice(_st: Arc<State>, listener: tokio::net::TcpListener) {
    let addr = listener.local_addr().ok();
    eprintln!("  trunk: listen_ice {addr:?} — not built yet (WIRE); connections are closed");
    loop {
        if let Ok((tcp, _)) = listener.accept().await {
            drop(tcp);
        }
    }
}
