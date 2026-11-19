//! The whole tree (p3, 11-19): every computer is a root with its own MAIN, and the home root —
//! the one the phone enters through — shows all of it.
//!
//! - A root that runs no app (a joined root, `YGG_ROOT_MAIN=1`) makes its own `[MAIN]` at start.
//!   `GET /root` names every root's MAIN; each root keeps ONE proxy of each peer's MAIN
//!   (`card.kind = "root-main"`, title `[MAIN] <root>`, under its own MAIN), so MAIN can talk to
//!   another MAIN with the tree tools and the phone can open it.
//! - `GET /root/{name}/sessions` lists what lives on a root; `POST /root/{name}/adopt` makes a
//!   proxy here for one of them (its `report_to` there is never touched).
//! - `POST /session {root}` from the phone starts a session there (a top-level proxy here).
//! - Work placed between roots carries a hop count (`info.hops`, `meta.from.hops`); past
//!   `peers::MAX_HOPS` it is refused (L6). Root A placing work on root B tells the home root
//!   (`POST /tree/placed`), which lists it; A forwards the reports there too.
//! - `DELETE /root/peers/{name}` forgets a root on purpose (the app's remove): its proxies here
//!   are archived, "root removed".

use std::collections::HashMap;

use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{AppState, Session, now_ms, peers, publish, with_session};

/// This root's own MAIN: the newest open `[MAIN]` that lives here.
pub fn local_main(st: &AppState) -> Option<String> {
    main_in(&st.sessions.lock().unwrap())
}

fn main_in(sessions: &HashMap<String, Session>) -> Option<String> {
    sessions
        .iter()
        .filter(|(_, s)| crate::is_main_title(s.info["title"].as_str().unwrap_or_default()) && !s.info["remote"].is_object() && s.info["archived"] != true)
        .max_by_key(|(_, s)| s.info["time"]["updated"].as_u64().unwrap_or(0))
        .map(|(id, _)| id.clone())
}

/// At start, on a root that runs no app (`YGG_ROOT_MAIN=1`): one `[MAIN]`, made here if there is
/// none (a root whose data came with its MAIN keeps that one).
pub fn ensure_main(st: &AppState) -> Option<String> {
    if let Some(id) = local_main(st) {
        return Some(id);
    }
    if !st.config.peers.own_main {
        return None;
    }
    let info = crate::new_session(st, "[MAIN]", None, Some("coordinator"), None, None);
    let id = info["id"].as_str().map(String::from);
    eprintln!("root {}: made its own [MAIN] {}", st.config.peers.me, id.as_deref().unwrap_or("?"));
    id
}

/// The local proxy of a session that lives on `root` as `rid`.
fn proxy_in(sessions: &HashMap<String, Session>, root: &str, rid: &str) -> Option<String> {
    sessions.iter().find(|(_, s)| s.info["remote"]["root"] == root && s.info["remote"]["id"] == rid).map(|(id, _)| id.clone())
}

/// The local proxy of `root`'s MAIN.
fn main_proxy_in(sessions: &HashMap<String, Session>, root: &str) -> Option<String> {
    sessions.iter().find(|(_, s)| s.info["remote"]["root"] == root && s.info["card"]["kind"] == "root-main").map(|(id, _)| id.clone())
}

pub fn is_root_main(s: &Session) -> bool {
    s.info["card"]["kind"] == "root-main"
}

/// `root`'s MAIN gets one proxy here, under this root's MAIN (kept pointing at the MAIN it names
/// now, and re-parented once this root has a MAIN). `rid` None = that root names no MAIN yet.
pub fn ensure_main_proxy(st: &AppState, root: &str, rid: Option<&str>) -> Option<String> {
    let rid = rid.filter(|r| !r.is_empty() && r.len() < 120)?;
    let (existing, mine) = {
        let sessions = st.sessions.lock().unwrap();
        (main_proxy_in(&sessions, root).map(|id| (id.clone(), sessions[&id].info.clone())), main_in(&sessions))
    };
    if let Some((id, info)) = existing {
        let stale = info["remote"]["id"] != rid || info["archived"] == true || (mine.is_some() && info["parentID"].as_str() != mine.as_deref());
        if stale {
            with_session(st, &id, |s| {
                s.info["remote"]["id"] = json!(rid);
                if s.info["archived"] == true {
                    s.info["archived"] = json!(false);
                    s.info["card"]["status"] = json!("idle");
                    s.info["card"]["headline"] = Value::Null;
                }
                if let Some(m) = &mine {
                    s.info["parentID"] = json!(m);
                }
            });
            publish(st, "tree.updated", json!({ "sessionID": id }));
        }
        return Some(id);
    }
    let title = format!("[MAIN] {root}");
    let info = crate::new_session(st, &title, mine.as_deref(), None, None, None);
    let id = info["id"].as_str()?.to_string();
    with_session(st, &id, |s| {
        s.info["remote"] = json!({ "root": root, "id": rid });
        s.info["card"] = json!({ "kind": "root-main", "topic": format!("{root}'s MAIN"), "root": root, "status": "idle",
            "created": now_ms(), "updated": now_ms() });
    });
    eprintln!("root {}: {root}'s MAIN is {rid} there, {id} here", st.config.peers.me);
    publish(st, "tree.updated", json!({ "sessionID": id, "parentID": mine }));
    Some(id)
}

/// Each peer's health for `GET /root`: reachable (answered in the last 3 minutes), when last
/// seen, what it is and runs, its MAIN there and here.
pub fn health(st: &AppState) -> Vec<Value> {
    let p = &st.config.peers;
    let peers = p.all();
    let seen = p.seen.lock().unwrap().clone();
    let sessions = st.sessions.lock().unwrap();
    let now = now_ms();
    peers
        .iter()
        .map(|(name, _)| {
            let (at, r) = seen.get(name).cloned().unwrap_or((0, Value::Null));
            let hw = &r["hardware"];
            json!({
                "name": name,
                "reachable": at > 0 && now.saturating_sub(at) < 180_000,
                "seen": at,
                "os": hw["os"], "arch": hw["arch"], "cpus": hw["cpus"], "mem_gb": hw["mem_gb"],
                "running": r["load"]["running"], "sessions": r["load"]["sessions"],
                "models": r["models"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect::<Vec<_>>(),
                "main": r["main"],
                "main_proxy": main_proxy_in(&sessions, name),
            })
        })
        .collect()
}

// ── hops (L6) ────────────────────────────────────────────────────────────────

/// How often the work `caller` is doing now has already passed between roots: its own (`info.hops`,
/// set when another root placed it here) or its current turn's (`meta.from.hops` of a message
/// another root sent it), whichever is more.
pub fn hops_here(st: &AppState, caller: &str) -> u64 {
    let sessions = st.sessions.lock().unwrap();
    let Some(s) = sessions.get(caller) else { return 0 };
    let own = s.info["hops"].as_u64().unwrap_or(0);
    let turn = s
        .messages
        .iter()
        .rev()
        .find(|m| m["info"]["role"] == "user")
        .filter(|m| m["info"]["meta"]["from"]["root"].is_string())
        .and_then(|m| m["info"]["meta"]["from"]["hops"].as_u64())
        .unwrap_or(0);
    own.max(turn)
}

/// The plain sentence a placement past the limit gets (None = it may go).
pub fn hop_refusal(st: &AppState, next: u64) -> Option<String> {
    (next > peers::MAX_HOPS).then(|| {
        format!(
            "refused: this work has already been passed from computer to computer {} times, the most allowed. Do it here on {}, or tell the user it cannot be passed on again.",
            next - 1,
            st.config.peers.me
        )
    })
}

// ── telling home (L6) ────────────────────────────────────────────────────────

/// This root placed work (proxy `pid`) on `root` as `rid`. When neither is the home root, home is
/// told so the phone lists it; the answer names home's proxy, and the reports follow it there.
pub fn tell_home(st: &AppState, pid: &str, root: &str, rid: &str, title: &str, profile: &str, caller: &str, hops: u64) {
    let Some(home) = st.config.peers.home.clone() else { return };
    if home == root {
        return; // it runs on home itself: home lists it already
    }
    let by_title = st.sessions.lock().unwrap().get(caller).map(|s| s.info["title"].as_str().unwrap_or_default().to_string()).unwrap_or_default();
    let body = json!({ "root": root, "id": rid, "title": title, "agent": profile, "hops": hops,
        "by": { "root": st.config.peers.me, "session": caller, "title": by_title } });
    let (st, pid, root, rid) = (st.clone(), pid.to_string(), root.to_string(), rid.to_string());
    tokio::spawn(async move {
        for attempt in 0..3u64 {
            match peers::call(&st, &home, "POST", "/tree/placed", Some(body.clone()), 15).await {
                Ok(v) => {
                    if let Some(hp) = v["proxy"].as_str() {
                        with_session(&st, &pid, |s| s.info["home_proxy"] = json!(hp));
                    }
                    return;
                }
                Err(e) => {
                    eprintln!("telling home {home} about {root}/{rid} failed ({}/3): {e}", attempt + 1);
                    tokio::time::sleep(std::time::Duration::from_secs(5 * (attempt + 1))).await;
                }
            }
        }
    });
}

/// A report came in for proxy `proxy`: when home holds a copy of it, home gets the report too.
pub fn forward_home(st: &AppState, proxy: &str, ev: &Value) {
    let Some(home) = st.config.peers.home.clone() else { return };
    let Some(hp) = st.sessions.lock().unwrap().get(proxy).and_then(|s| s.info["home_proxy"].as_str().map(String::from)) else { return };
    let (st, body) = (st.clone(), json!({ "proxy": hp, "event": ev }));
    tokio::spawn(async move {
        if let Err(e) = peers::call(&st, &home, "POST", "/tree/report", Some(body), 15).await {
            eprintln!("forwarding a report to home {home} failed: {e}");
        }
    });
}

/// Home's side of `tell_home`: a proxy here for work root `by.root` placed on `root` (made once
/// per session). Returns the proxy (or the session itself when it lives here).
pub fn placed(st: &AppState, body: &Value) -> Result<String, String> {
    let root = body["root"].as_str().filter(|r| peers::valid_id(r)).ok_or("root required")?;
    let rid = body["id"].as_str().filter(|r| !r.is_empty() && r.len() < 120).ok_or("id required")?;
    if root == st.config.peers.me {
        return Ok(rid.to_string());
    }
    let clip = |v: &Value, n: usize| v.as_str().unwrap_or_default().chars().take(n).collect::<String>();
    let title = {
        let sessions = st.sessions.lock().unwrap();
        if let Some(p) = proxy_in(&sessions, root, rid) {
            return Ok(p);
        }
        crate::tree::unique_title(&sessions, &clip(&body["title"], 80))
    };
    let agent = body["agent"].as_str().filter(|a| crate::agent(st, a).is_some());
    let info = crate::new_session(st, &title, None, agent, None, None);
    let id = info["id"].as_str().unwrap_or_default().to_string();
    let by = json!({ "root": clip(&body["by"]["root"], 64), "title": clip(&body["by"]["title"], 120) });
    with_session(st, &id, |s| {
        s.info["remote"] = json!({ "root": root, "id": rid });
        if let Some(h) = body["hops"].as_u64() {
            s.info["hops"] = json!(h.min(10));
        }
        s.info["card"] = json!({ "topic": title, "status": "working", "root": root, "placed_by": by,
            "created": now_ms(), "updated": now_ms() });
    });
    eprintln!("root {}: {} placed {title:?} on {root} ({rid}) — listed here as {id}", st.config.peers.me, by["root"].as_str().unwrap_or("?"));
    publish(st, "tree.updated", json!({ "sessionID": id }));
    Ok(id)
}

// ── what lives on a root ─────────────────────────────────────────────────────

fn row(id: &str, info: &Value, busy: bool, proxy: Option<String>) -> Value {
    let card = &info["card"];
    let status = if busy { "working".to_string() } else { card["status"].as_str().unwrap_or("idle").to_string() };
    json!({ "id": id, "title": info["title"], "agent": info["agent"], "status": status,
        "headline": card["headline"].as_str().or(card["summary"].as_str()), "busy": busy,
        "updated": info["time"]["updated"], "proxy": proxy })
}

/// A session the sheet lists for its root: one that lives there, open, not a test.
fn listed(info: &Value) -> bool {
    !info["remote"].is_object() && info["archived"] != true && info["test"] != true
}

fn sorted(mut rows: Vec<Value>) -> Vec<Value> {
    rows.sort_by_key(|r| std::cmp::Reverse(r["updated"].as_u64().unwrap_or(0)));
    rows.truncate(60);
    rows
}

/// `GET /root/{name}/sessions` — what lives on that root: its MAIN, then its sessions.
pub async fn sessions(st: &AppState, name: &str) -> Value {
    let me = st.config.peers.me.clone();
    if name == me {
        let sessions = st.sessions.lock().unwrap();
        let running = st.running.lock().unwrap();
        let main = main_in(&sessions);
        let rows = sessions
            .iter()
            .filter(|(id, s)| listed(&s.info) && Some(*id) != main.as_ref())
            .map(|(id, s)| row(id, &s.info, running.contains_key(id), Some(id.clone())))
            .collect();
        let main = main.map(|m| json!({ "id": m, "proxy": m, "title": sessions[&m].info["title"] }));
        return json!({ "root": me, "reachable": true, "main": main, "sessions": sorted(rows) });
    }
    let (list, busy) = tokio::join!(peers::call(st, name, "GET", "/session", None, 5), peers::call(st, name, "GET", "/session/status", None, 5));
    let sessions = st.sessions.lock().unwrap();
    match list {
        Ok(Value::Array(infos)) => {
            let busy = busy.unwrap_or(Value::Null);
            let main = infos.iter().filter(|i| crate::is_main_title(i["title"].as_str().unwrap_or_default()) && listed(i)).max_by_key(|i| i["time"]["updated"].as_u64().unwrap_or(0));
            let main_id = main.and_then(|m| m["id"].as_str()).map(String::from);
            let rows = infos
                .iter()
                .filter(|i| listed(i) && i["id"].as_str().is_some() && i["id"].as_str() != main_id.as_deref())
                .map(|i| {
                    let id = i["id"].as_str().unwrap_or_default();
                    row(id, i, busy[id].is_object(), proxy_in(&sessions, name, id))
                })
                .collect();
            let main = main_id.map(|m| json!({ "id": m, "proxy": main_proxy_in(&sessions, name), "title": "[MAIN]" }));
            json!({ "root": name, "reachable": true, "main": main, "sessions": sorted(rows) })
        }
        // not there right now: what this root holds of it, greyed on the phone
        other => {
            if let Err(e) = &other {
                eprintln!("root sessions: {e}");
            }
            let rows = sessions
                .iter()
                .filter(|(_, s)| s.info["remote"]["root"] == name && !is_root_main(s) && s.info["archived"] != true)
                .map(|(id, s)| {
                    let rid = s.info["remote"]["id"].as_str().unwrap_or_default();
                    row(rid, &s.info, false, Some(id.clone()))
                })
                .collect();
            let main = main_proxy_in(&sessions, name).map(|p| json!({ "id": sessions[&p].info["remote"]["id"], "proxy": p, "title": "[MAIN]" }));
            json!({ "root": name, "reachable": false, "main": main, "sessions": sorted(rows) })
        }
    }
}

/// `POST /root/{name}/adopt {id}` — a proxy here for a session that lives on that root, so the
/// phone can open it (made once; its `report_to` there is never touched).
pub async fn adopt(st: &AppState, name: &str, rid: &str) -> Result<Value, (StatusCode, String)> {
    if name == st.config.peers.me {
        let sessions = st.sessions.lock().unwrap();
        return match sessions.get(rid) {
            Some(s) => Ok(json!({ "proxy": rid, "title": s.info["title"] })),
            None => Err((StatusCode::NOT_FOUND, format!("no session {rid} here"))),
        };
    }
    let known = {
        let sessions = st.sessions.lock().unwrap();
        proxy_in(&sessions, name, rid).map(|p| (p.clone(), sessions[&p].info["title"].clone()))
    };
    if let Some((p, title)) = known {
        return Ok(json!({ "proxy": p, "title": title }));
    }
    let info = peers::call(st, name, "GET", &format!("/session/{rid}"), None, 10).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    if info["id"].as_str() != Some(rid) || info["remote"].is_object() {
        return Err((StatusCode::NOT_FOUND, format!("no session {rid} on {name}")));
    }
    if crate::is_main_title(info["title"].as_str().unwrap_or_default()) {
        let p = ensure_main_proxy(st, name, Some(rid)).ok_or((StatusCode::BAD_GATEWAY, "no MAIN proxy".to_string()))?;
        return Ok(json!({ "proxy": p, "title": format!("[MAIN] {name}") }));
    }
    let (title, raced) = {
        let sessions = st.sessions.lock().unwrap();
        (crate::tree::unique_title(&sessions, info["title"].as_str().unwrap_or("session")), proxy_in(&sessions, name, rid))
    };
    // a second adopt racing this one: the first proxy wins
    if let Some(p) = raced {
        return Ok(json!({ "proxy": p, "title": title }));
    }
    let agent = info["agent"].as_str().filter(|a| *a != "coordinator" && crate::agent(st, a).is_some());
    let made = crate::new_session(st, &title, None, agent, None, None);
    let pid = made["id"].as_str().unwrap_or_default().to_string();
    let card = &info["card"];
    with_session(st, &pid, |s| {
        s.info["remote"] = json!({ "root": name, "id": rid });
        s.info["card"] = json!({ "topic": title, "status": card["status"].as_str().unwrap_or("idle"), "headline": card["headline"],
            "root": name, "adopted": true, "created": now_ms(), "updated": now_ms() });
    });
    publish(st, "tree.updated", json!({ "sessionID": pid }));
    Ok(json!({ "proxy": pid, "title": title }))
}

/// `POST /session {title, agent?, root}` from the phone: the session is made on `root`; here it is
/// a top-level proxy. Nothing is posted yet (the owner types the first message).
pub async fn create_remote(st: &AppState, root: &str, title: &str, agent: Option<&str>) -> Result<Value, String> {
    let agent = agent.filter(|a| *a != "coordinator");
    let (pid, _) = peers::open(st, None, root, title, agent, None, None, 0).await?;
    with_session(st, &pid, |s| {
        s.info["card"] = json!({ "topic": title, "status": "idle", "root": root, "created": now_ms(), "updated": now_ms() });
        s.info.clone()
    })
    .ok_or_else(|| "the proxy vanished".to_string())
}

/// Forgets `name` on purpose: no longer a peer (not learned again by this process), its proxies
/// here archived with "root removed". Returns how many were archived.
pub fn remove(st: &AppState, name: &str) -> usize {
    let p = &st.config.peers;
    p.removed.lock().unwrap().insert(name.to_string());
    p.learned.lock().unwrap().retain(|(n, _)| n != name);
    p.seen.lock().unwrap().remove(name);
    let ids: Vec<String> = st.sessions.lock().unwrap().iter().filter(|(_, s)| s.info["remote"]["root"] == name).map(|(id, _)| id.clone()).collect();
    let mut n = 0;
    for id in &ids {
        if let Some(true) = with_session(st, id, |s| {
            if s.info["archived"] == true && s.info["card"]["headline"] == "root removed" {
                return false;
            }
            s.info["archived"] = json!(true);
            s.info["time"]["archived"] = json!(now_ms());
            if !s.info["card"].is_object() {
                s.info["card"] = json!({});
            }
            s.info["card"]["status"] = json!("archived");
            s.info["card"]["headline"] = json!("root removed");
            true
        }) {
            n += 1;
        }
    }
    eprintln!("root {}: {name} removed — {n} session(s) here archived", p.me);
    publish(st, "tree.updated", json!({ "root": name, "removed": true }));
    n
}

// ── routes ───────────────────────────────────────────────────────────────────

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

pub async fn get_sessions(State(st): State<AppState>, Path(name): Path<String>) -> Response {
    if name != st.config.peers.me && st.config.peers.url(&name).is_none() && !has_proxies(&st, &name) {
        return err(StatusCode::NOT_FOUND, &format!("unknown root {name}"));
    }
    Json(sessions(&st, &name).await).into_response()
}

fn has_proxies(st: &AppState, name: &str) -> bool {
    st.sessions.lock().unwrap().values().any(|s| s.info["remote"]["root"] == name)
}

pub async fn post_adopt(State(st): State<AppState>, Path(name): Path<String>, Json(body): Json<Value>) -> Response {
    let Some(rid) = body["id"].as_str().filter(|r| !r.is_empty()) else { return err(StatusCode::BAD_REQUEST, "id required") };
    match adopt(&st, &name, rid).await {
        Ok(v) => Json(v).into_response(),
        Err((code, e)) => err(code, &e),
    }
}

/// `DELETE /root/peers/{name}` — from this box only (the app's remove), never from another root.
pub async fn delete_peer(State(st): State<AppState>, ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>, headers: HeaderMap, Path(name): Path<String>) -> Response {
    if !addr.ip().is_loopback() || peers::from_peer(&headers) {
        return err(StatusCode::FORBIDDEN, "only this computer removes a root");
    }
    if name == st.config.peers.me || !peers::valid_id(&name) {
        return err(StatusCode::BAD_REQUEST, "not another root");
    }
    let n = remove(&st, &name);
    Json(json!({ "removed": name, "archived": n })).into_response()
}

/// `POST /tree/placed` — another root placed work between two roots; listed here (peer only).
pub async fn post_placed(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !st.config.peers.authorized(&headers) {
        return err(StatusCode::UNAUTHORIZED, "peer token");
    }
    match placed(&st, &body) {
        Ok(p) => Json(json!({ "proxy": p })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}
