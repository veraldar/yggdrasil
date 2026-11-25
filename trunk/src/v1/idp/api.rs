//! `/t/*` (spec §7) — the trunk's own API, answered here (WIRE's `/t/*` routes were offered to
//! `relay::route` first).

use std::sync::Arc;

use serde_json::json;

use crate::v1::http::Resp;
use crate::v1::relay;
use crate::v1::server::{Incoming, State};
use crate::v1::shell;

pub async fn handle(st: Arc<State>, inc: Incoming) {
    let route = inc.req.route().trim_end_matches('/').to_string();
    let method = inc.req.method.clone();
    if let Some(name) = route.strip_prefix("/t/s/") {
        let r = shell::asset(name);
        return inc.answer(r).await;
    }
    let r = match (method.as_str(), route.as_str()) {
        ("GET" | "HEAD", "/t/state") => state(&st),
        _ => Resp::json(404, &json!({ "error": "not found" })),
    };
    inc.answer(r).await
}

/// GET /t/state — `{claimed, has_roots, lockdown, providers[]}` (anyone).
pub fn state(st: &State) -> Resp {
    let providers: Vec<&String> = st.cfg.oauth.keys().collect();
    Resp::json(
        200,
        &json!({
            "claimed": st.claimed(),
            "has_roots": relay::has_roots(st),
            "lockdown": st.lockdown(),
            "providers": providers,
        }),
    )
}
