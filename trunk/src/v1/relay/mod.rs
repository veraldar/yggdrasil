//! WIRE's place in the trunk (CONTRACTS.md C1/C4/C6): the four hooks the skeleton's router calls,
//! on top of the relay core (`hub.rs`) and the roots registry/enrollment (`../roots`).
//!
//! Routes answered here, before the trunk's namespace: `WS /t/root`, `/t/roots*` (list, pending,
//! enroll start/poll/card/approve/refuse/by-code, rename, revoke), `/t/me/roots`, `/t/me/door`,
//! `/t/ice/owner`. Everything else outside the trunk's namespace reaches `to_door` after the C3
//! check and goes to the device's door root.

pub mod hub;

use std::sync::{Arc, OnceLock};

use super::db::Migration;
use super::http::Resp;
use super::paseto::Claims;
use super::roots;
use super::server::{Incoming, State};

pub use hub::Hub;

/// WIRE's numbered migrations (100–199), merged into the runner by number.
pub const MIGRATIONS: &[Migration] = &[(100, "roots", include_str!("../migrations/100_roots.sql"))];

/// WIRE's in-memory state (live root links, ufrag routes, the enrollment window), one per trunk.
#[derive(Default)]
pub struct Relay {
    hub: OnceLock<Arc<Hub>>,
    pub enroll: roots::EnrollWindow,
}

/// The relay's state of this trunk.
pub fn relay(st: &State) -> &Relay {
    &st.relay
}

/// The hub (made on first use: its registry reads trunk.db through the `Arc<State>`).
pub fn hub(st: &Arc<State>) -> &Arc<Hub> {
    st.relay.hub.get_or_init(|| {
        let key = Arc::new(super::proto::SignKey::from_seed(st.trunk_key.seed()).expect("the trunk key's seed"));
        Hub::new(&st.trunk_id, key, Arc::new(roots::DbRegistry::new(st)), Arc::new(roots::DbAuthority { st: Arc::downgrade(st) }))
    })
}

/// The identity side tells every root at once (spec §5.4). The IDP calls these on a device
/// revoke, the kill switch, a key rotation; each push is signed (C4).
pub fn device_revoked(st: &Arc<State>, did: &str, until_ms: u64) {
    hub(st).push_revoke(did, until_ms);
}
pub fn killed(st: &Arc<State>, epoch: u64, lockdown: bool) {
    hub(st).push_kill(epoch, lockdown);
}
pub fn keys_changed(st: &Arc<State>) {
    hub(st).push_keys();
}

fn segs(route: &str) -> Vec<&str> {
    route.trim_end_matches('/').split('/').skip(1).collect()
}

/// First look at every request: `None` = answered here, `Some(inc)` = not WIRE's.
pub async fn route(st: &Arc<State>, mut inc: Incoming) -> Option<Incoming> {
    let route = inc.req.route().to_string();
    // the enrollment pages (storyboard step 4) and their script
    let get = matches!(inc.req.method.as_str(), "GET" | "HEAD");
    match route.trim_end_matches('/') {
        "/auth/root" | "/add-root" if get => {
            let which = if route.starts_with("/auth/root") { "auth-root" } else { "add-root" };
            let r = roots::pages::page(st, &inc, which);
            inc.answer(r).await;
            return None;
        }
        "/t/roots/ui.js" if get => {
            inc.answer(roots::pages::ui_js()).await;
            return None;
        }
        _ => {}
    }
    let s = segs(&route);
    let mine = matches!(s.as_slice(), ["t", "root"] | ["t", "roots", ..] | ["t", "me", "roots"] | ["t", "me", "door"] | ["t", "ice", "owner"]);
    if !mine {
        return Some(inc);
    }
    // canonical paths only: a path that only normalizes into this namespace is not ours
    // (normalize_path folds case; ids are mixed-case b64url)
    if super::http::normalize_path(&route) != route.trim_end_matches('/').to_ascii_lowercase() {
        inc.answer(Resp::text(404, "not here\n")).await;
        return None;
    }
    let method = inc.req.method.clone();
    let st = st.clone();
    let r = match (method.as_str(), s.as_slice()) {
        ("GET", ["t", "root"]) => {
            let hub = hub(&st).clone();
            let Incoming { io, head, rest, peer, .. } = inc;
            let _ = hub.serve_root(io, peer, &head, rest).await;
            return None;
        }
        (_, ["t", "root"]) => Resp::text(405, "GET (a websocket)\n"),
        ("GET", ["t", "ice", "owner"]) => {
            // only the router (sni-443 v2) on the Incus bridge may ask: the socket peer, never XFF
            let allowed = st.cfg.ice_owner_cidrs().iter().any(|c| c.contains(super::config::canon(inc.peer.ip())));
            if !allowed {
                Resp::text(403, "not here\n")
            } else {
                match inc.req.query("u").and_then(|u| hub(&st).ice_owner_now(&u)) {
                    Some(_) => Resp::text(200, "ok\n"),
                    None => Resp::text(404, "unknown\n"),
                }
            }
        }
        // the installer's two calls carry their own credential (none, then the poll secret)
        ("POST", ["t", "roots", "enroll"]) => roots::enroll_start(&st, &mut inc).await,
        ("POST", ["t", "roots", "enroll", id, "poll"]) => {
            let id = id.to_string();
            roots::enroll_poll(&st, &mut inc, &id).await
        }
        _ => {
            // everything else: a signed-in device; writes from the trunk's own pages only
            match roots::device(&st, &inc) {
                Err(r) => r,
                Ok(who) => match (inc.req.is_write(), roots::same_origin(&st, &inc)) {
                    (true, Err(r)) => r,
                    _ => {
                        let s: Vec<String> = s.iter().map(|x| x.to_string()).collect();
                        let s: Vec<&str> = s.iter().map(String::as_str).collect();
                        device_route(&st, &mut inc, &who, &method, &s).await
                    }
                },
            }
        }
    };
    inc.answer(r).await;
    None
}

async fn device_route(st: &Arc<State>, inc: &mut Incoming, who: &Claims, method: &str, s: &[&str]) -> Resp {
    match (method, s) {
        ("GET", ["t", "me", "roots"]) => roots::me_roots(st, who),
        ("PUT", ["t", "me", "door"]) => roots::me_door(st, inc, who).await,
        ("GET", ["t", "roots"]) => roots::roots_list(st, who),
        ("GET", ["t", "roots", "pending"]) => roots::roots_pending(st, inc),
        ("POST", ["t", "roots", "enroll", "by-code"]) => roots::enroll_by_code(st, inc, who).await,
        ("GET", ["t", "roots", "enroll", id]) => roots::enroll_card(st, inc, who, id),
        ("POST", ["t", "roots", "enroll", id, "approve"]) => roots::enroll_approve(st, inc, who, id).await,
        ("POST", ["t", "roots", "enroll", id, "refuse"]) => roots::enroll_refuse(st, who, id),
        ("PATCH", ["t", "roots", id]) => roots::root_patch(st, inc, who, id).await,
        ("DELETE", ["t", "roots", id]) => roots::root_revoke(st, who, id, "removed by an admin"),
        _ => Resp::json(404, &serde_json::json!({ "error": "not found" })),
    }
}

/// Does this trunk have at least one enrolled, unrevoked root? (`/t/state` `has_roots`, the
/// empty-trunk page.)
pub fn has_roots(st: &State) -> bool {
    if !st.db.table_exists("roots") {
        return false;
    }
    st.db
        .with(|c| c.query_row("SELECT EXISTS (SELECT 1 FROM roots WHERE revoked_at IS NULL)", [], |r| r.get::<_, bool>(0)))
        .unwrap_or(false)
}

/// A request outside the trunk's own namespace from a device whose token passed the C3 checks:
/// one mux stream to the device's door root (its choice when online and running the app, else the
/// first such root); none online → `/offline` (a page) or 503. The root's bridge applies the whole
/// stream law again (P12) and re-checks the token offline (C3).
pub async fn to_door(st: &Arc<State>, inc: Incoming, who: Claims) {
    let Some(door) = roots::door_for(st, &who.did) else {
        let r: Resp = super::shell::offline_for(&inc.req);
        return inc.answer(r).await;
    };
    let hsts = inc.tls.then_some("max-age=31536000");
    let Incoming { io, head, rest, ip, .. } = inc;
    let _ = hub(st).relay_http(&door, io, ip, &head, rest, hsts).await;
}

/// `listen_ice` (phase 2): framed STUN / ICE-TCP routed by registered ufrag (§5.7).
pub async fn serve_ice(st: Arc<State>, listener: tokio::net::TcpListener) {
    let hub = hub(&st).clone();
    println!("  trunk: ICE-TCP {:?} → the root that registered the ufrag", listener.local_addr().ok());
    loop {
        match listener.accept().await {
            Ok((tcp, peer)) => {
                let h = hub.clone();
                tokio::spawn(async move { h.serve_ice(tcp, peer).await });
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
}

#[cfg(all(test, feature = "bridge"))]
mod tests;
