//! A session on another root is a full session (package 2, decision L4).
//!
//! A proxy here (`info.remote = {root, id}`) used to forward a turn and wait up to 15 minutes for
//! its end, over a line that gives up after 2 minutes; no event of the other root ever came back.
//! Now one mechanism makes it behave like a local session:
//!
//! - **Every root keeps a journal** of the events it publishes (a ring, numbered) and serves it at
//!   `POST /event/feed {after, sessions, wait}`: the events of those sessions after `after`, held
//!   up to `wait` seconds until there is one (a long poll: the line between roots carries whole
//!   replies only, never a stream).
//! - **The home root follows** the other root's feed for every proxy it watches (a turn in
//!   flight, or the phone reading it in the last minute), one follower per root, and republishes
//!   each event under the proxy's id: deltas, parts, message updates, errors, busy, idle. So the
//!   phone's watchdog, its busy dot and the voice agent need no special case.
//! - **A turn is forwarded without waiting** for its end (`?async=1`, with a key the other root
//!   runs once); its client here gets what a local turn gives: the SSE stream, the held POST,
//!   or the async answer.
//! - **Cancel is forwarded**: while a forwarded turn runs, the proxy sits in `running` with a
//!   handle whose notify forwards the abort.
//! - **A link that drops** ends the turn with "no answer from <root>" (error + idle + the card),
//!   instead of a session that hangs.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response, sse::Event},
};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::{AppState, now_ms, publish, with_session};

const RING_EVENTS: usize = 4096;
const RING_BYTES: usize = 16 << 20;
/// one feed answer stays well under the line's 4 MB
const REPLY_BYTES: usize = 2 << 20;
const FEED_WAIT_S: u64 = 20;
/// how long a proxy the phone just read stays followed
const VIEW_MS: u64 = 60_000;

/// No answer for this long while a turn runs = the link is down (YGG_RELAY_LOST_S, default 45).
fn lost_ms() -> u64 {
    std::env::var("YGG_RELAY_LOST_S").ok().and_then(|v| v.parse::<u64>().ok()).filter(|n| *n > 0).unwrap_or(45) * 1000
}

struct Journal {
    epoch: String,
    seq: u64,
    /// (seq, session, size, event)
    ring: VecDeque<(u64, String, usize, Value)>,
    bytes: usize,
}

pub struct Relay {
    journal: Mutex<Journal>,
    bell: Notify,
    /// proxy id → what is followed for it
    watches: Mutex<HashMap<String, Watch>>,
    /// root → its follower (present = running)
    followers: Mutex<HashMap<String, Arc<Follower>>>,
}

impl Default for Relay {
    fn default() -> Self {
        Relay {
            journal: Mutex::new(Journal { epoch: uuid::Uuid::new_v4().simple().to_string(), seq: 0, ring: VecDeque::new(), bytes: 0 }),
            bell: Notify::new(),
            watches: Mutex::default(),
            followers: Mutex::default(),
        }
    }
}

#[derive(Default)]
struct Follower {
    /// the watched set changed: ask again from the same point
    changed: Notify,
    /// the follower knows where the other root's journal stands (a turn may be posted)
    primed: AtomicBool,
    primed_bell: Notify,
}

struct Watch {
    root: String,
    rid: String,
    view_until: u64,
    turns: Vec<PendingTurn>,
    busy: Option<Busy>,
    /// the turn the other root is answering now (its user message id)
    current: Option<String>,
    /// events that came before the turn they belong to was known: (turn id, kind, props)
    early: Vec<(String, String, Value)>,
    /// the card already says the link is down
    lost: bool,
}

struct PendingTurn {
    turn_id: Option<String>,
    sink: Option<mpsc::Sender<Event>>,
    done: Option<oneshot::Sender<Result<Value, String>>>,
}

struct Busy {
    abort: Arc<Notify>,
    released: Arc<AtomicBool>,
}

/// The session an event is about (`None`: not about one).
fn session_of(ev: &Value) -> Option<String> {
    let p = &ev["properties"];
    let s = p["sessionID"].as_str().or(p["info"]["sessionID"].as_str()).or(p["part"]["sessionID"].as_str());
    let s = s.or_else(|| ev["type"].as_str().filter(|t| t.starts_with("session.")).and(p["info"]["id"].as_str()));
    s.map(String::from)
}

/// Every journaled event: called by `publish`.
pub fn journal(st: &AppState, ev: &Value) {
    let Some(sid) = session_of(ev) else { return };
    let size = ev.to_string().len();
    {
        let mut j = st.relay.journal.lock().unwrap();
        j.seq += 1;
        let seq = j.seq;
        j.ring.push_back((seq, sid, size, ev.clone()));
        j.bytes += size;
        while j.ring.len() > RING_EVENTS || j.bytes > RING_BYTES {
            let Some((_, _, n, _)) = j.ring.pop_front() else { break };
            j.bytes -= n;
        }
    }
    st.relay.bell.notify_waiters();
}

/// What the journal holds after `after` for `sessions`: (seq to ask from next, gap, events).
fn collect(j: &Journal, epoch: Option<&str>, after: Option<u64>, sessions: &HashSet<String>) -> (u64, bool, Vec<Value>) {
    let Some(after) = after.filter(|_| epoch == Some(j.epoch.as_str())) else {
        // first ask (or this root restarted since): where it stands now
        return (j.seq, after.is_some(), vec![]);
    };
    let first = j.ring.front().map(|e| e.0).unwrap_or(j.seq + 1);
    let gap = after + 1 < first && after < j.seq;
    let (mut out, mut bytes, mut next) = (vec![], 0usize, j.seq);
    for (seq, sid, size, ev) in j.ring.iter().filter(|e| e.0 > after) {
        if !sessions.contains(sid) {
            continue;
        }
        if bytes + size > REPLY_BYTES && !out.is_empty() {
            next = seq - 1;
            break;
        }
        bytes += size;
        let mut e = ev.clone();
        e["seq"] = json!(seq);
        out.push(e);
    }
    (next, gap, out)
}

/// `POST /event/feed {after, epoch, sessions, wait}` → `{epoch, seq, gap, busy, events}`.
pub async fn feed(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<Value>) -> Response {
    if !st.config.peers.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "peer token" }))).into_response();
    }
    let sessions: HashSet<String> = b["sessions"].as_array().into_iter().flatten().filter_map(|s| s.as_str()).take(500).map(String::from).collect();
    let wait = Duration::from_secs(b["wait"].as_u64().unwrap_or(0).min(25));
    let (after, epoch) = (b["after"].as_u64(), b["epoch"].as_str().map(String::from));
    let deadline = Instant::now() + wait;
    loop {
        let rung = st.relay.bell.notified();
        let (epoch_now, (seq, gap, events)) = {
            let j = st.relay.journal.lock().unwrap();
            (j.epoch.clone(), collect(&j, epoch.as_deref(), after, &sessions))
        };
        let now = Instant::now();
        if !events.is_empty() || gap || after.is_none() || epoch.as_deref() != Some(epoch_now.as_str()) || now >= deadline {
            let busy: Vec<String> = {
                let running = st.running.lock().unwrap();
                sessions.iter().filter(|s| running.contains_key(*s)).cloned().collect()
            };
            return Json(json!({ "epoch": epoch_now, "seq": seq, "gap": gap, "busy": busy, "events": events })).into_response();
        }
        let _ = tokio::time::timeout(deadline - now, rung).await;
    }
}

// ---- the home side -----------------------------------------------------------------------

/// The other root's id replaced by the proxy's, everywhere in an event.
fn rewrite(v: &mut Value, rid: &str, proxy: &str) {
    match v {
        Value::String(s) if s == rid => *s = proxy.to_string(),
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite(x, rid, proxy)),
        Value::Object(o) => o.values_mut().for_each(|x| rewrite(x, rid, proxy)),
        _ => {}
    }
}

fn sse(kind: &str, props: &Value) -> Event {
    Event::default().event(kind).json_data(props).unwrap_or_default()
}

/// Starts following `proxy` (on `root`, there `rid`) if it is not yet; `view`: the phone reads it.
fn watch_locked(st: &AppState, w: &mut HashMap<String, Watch>, proxy: &str, root: &str, rid: &str, view: bool) {
    let e = w.entry(proxy.to_string()).or_insert_with(|| Watch {
        root: root.to_string(),
        rid: rid.to_string(),
        view_until: 0,
        turns: vec![],
        busy: None,
        current: None,
        early: vec![],
        lost: false,
    });
    if view {
        e.view_until = now_ms() + VIEW_MS;
    }
    let mut f = st.relay.followers.lock().unwrap();
    match f.get(root) {
        Some(fo) => fo.changed.notify_one(),
        None => {
            let fo = Arc::new(Follower::default());
            f.insert(root.to_string(), fo.clone());
            let (st, root) = (st.clone(), root.to_string());
            tokio::spawn(async move { follow(st, root, fo).await });
        }
    }
}

/// The phone read a proxy: follow it for a minute (its busy state and events come home).
pub fn view(st: &AppState, proxy: &str, root: &str, rid: &str) {
    let mut w = st.relay.watches.lock().unwrap();
    watch_locked(st, &mut w, proxy, root, rid, true);
}

/// Marks the proxy busy here: in `running` (status, tree, abort) with a handle that forwards the
/// abort. Publishes `session.status` busy when it was not.
fn mark_busy(st: &AppState, w: &mut Watch, proxy: &str) {
    if w.busy.is_some() {
        return;
    }
    let abort = Arc::new(Notify::new());
    let released = Arc::new(AtomicBool::new(false));
    st.running.lock().unwrap().insert(proxy.to_string(), abort.clone());
    w.busy = Some(Busy { abort: abort.clone(), released: released.clone() });
    let (st2, proxy2, root, rid) = (st.clone(), proxy.to_string(), w.root.clone(), w.rid.clone());
    tokio::spawn(async move {
        loop {
            abort.notified().await;
            if released.load(Ordering::SeqCst) {
                return;
            }
            forward_abort(&st2, &proxy2, &root, &rid).await;
        }
    });
    publish(st, "session.status", json!({ "sessionID": proxy, "status": { "type": "busy" } }));
}

fn release(st: &AppState, w: &mut Watch, proxy: &str) -> bool {
    let Some(b) = w.busy.take() else { return false };
    b.released.store(true, Ordering::SeqCst);
    {
        let mut running = st.running.lock().unwrap();
        if running.get(proxy).is_some_and(|n| Arc::ptr_eq(n, &b.abort)) {
            running.remove(proxy);
        }
    }
    b.abort.notify_one();
    true
}

/// What to do once the watches lock is let go (sends can wait on a slow client).
#[derive(Default)]
struct After {
    sends: Vec<(mpsc::Sender<Event>, Event)>,
    ends: Vec<(PendingTurn, Result<Value, String>)>,
    resolve: Option<String>,
}

impl After {
    async fn run(self, st: &AppState) {
        for (tx, ev) in self.sends {
            let _ = tx.send(ev).await;
        }
        for (mut t, r) in self.ends {
            if let (Some(tx), Err(e)) = (&t.sink, &r) {
                let _ = tx.send(Event::default().event("error").json_data(json!({ "error": e })).unwrap_or_default()).await;
            }
            t.sink = None;
            if let Some(d) = t.done.take() {
                let _ = d.send(r);
            }
        }
        if let Some(p) = self.resolve {
            tokio::spawn(resolve_later(st.clone(), p));
        }
    }
}

/// Takes the turn `turn_id` out of the watch (with its result) and, when none is left and the
/// other root is not busy, lets the proxy go idle here.
fn end_turn(w: &mut Watch, turn_id: &str, r: Result<Value, String>, after: &mut After) {
    if let Some(i) = w.turns.iter().position(|t| t.turn_id.as_deref() == Some(turn_id)) {
        let t = w.turns.remove(i);
        after.ends.push((t, r));
    }
}

/// One event of the other root, for `proxy`.
fn on_event(st: &AppState, proxy: &str, w: &mut Watch, mut ev: Value, after: &mut After) {
    let kind = ev["type"].as_str().unwrap_or_default().to_string();
    rewrite(&mut ev["properties"], &w.rid, proxy);
    let props = ev["properties"].take();
    let sinks_for = |w: &Watch, turn: Option<&str>| -> Vec<mpsc::Sender<Event>> {
        w.turns.iter().filter(|t| turn.is_some() && t.turn_id.as_deref() == turn).filter_map(|t| t.sink.clone()).collect()
    };
    let unknown_turn = |w: &Watch, turn: &str| w.turns.iter().any(|t| t.turn_id.is_none()) && !w.turns.iter().any(|t| t.turn_id.as_deref() == Some(turn));
    match kind.as_str() {
        "session.status" => {
            if props["status"]["type"] == "busy" {
                mark_busy(st, w, proxy);
            }
        }
        "session.idle" => {
            w.current = None;
            publish(st, "session.idle", props);
            if w.turns.is_empty() {
                release(st, w, proxy);
            } else {
                after.resolve = Some(proxy.to_string());
            }
        }
        "message.updated" => {
            let info = &props["info"];
            if info["role"] == "assistant" && info["time"]["completed"].is_null() {
                if let Some(t) = info["parentID"].as_str() {
                    w.current = Some(t.to_string());
                }
            }
            publish(st, "message.updated", props);
        }
        "message.part.delta" | "message.part.updated" => {
            if let Some(cur) = w.current.clone() {
                if unknown_turn(w, &cur) {
                    w.early.push((cur, kind.clone(), props.clone()));
                } else {
                    for tx in sinks_for(w, Some(&cur)) {
                        after.sends.push((tx, sse(&kind, &props)));
                    }
                }
            }
            publish(st, &kind, props);
        }
        "message.completed" | "message.aborted" => {
            let turn = props["info"]["parentID"].as_str().map(String::from);
            if let Some(t) = &turn {
                for tx in sinks_for(w, Some(t)) {
                    after.sends.push((tx, sse(&kind, &props)));
                }
                if unknown_turn(w, t) {
                    w.early.push((t.clone(), kind.clone(), props.clone()));
                } else {
                    end_turn(w, t, Ok(props.clone()), after);
                }
            }
            publish(st, &kind, props);
        }
        "error" => {
            let e = props["error"].as_str().unwrap_or("the reply failed").to_string();
            if let Some(cur) = w.current.clone() {
                if unknown_turn(w, &cur) {
                    w.early.push((cur, kind.clone(), props.clone()));
                } else {
                    // the stream's own error event goes out in end_turn
                    end_turn(w, &cur, Err(e), after);
                }
            }
            publish(st, "error", props);
        }
        "todo.updated" | "session.compacted" => publish(st, &kind, props),
        _ => {}
    }
}

/// A turn's id became known: the events that came first go to its client now.
fn flush_early(w: &mut Watch, turn_id: &str, after: &mut After) {
    let early = std::mem::take(&mut w.early);
    for (t, kind, props) in early {
        if t != turn_id {
            // still another unknown turn's, or someone else's: kept only while a turn is unknown
            if w.turns.iter().any(|x| x.turn_id.is_none()) {
                w.early.push((t, kind, props));
            }
            continue;
        }
        let sinks: Vec<_> = w.turns.iter().filter(|x| x.turn_id.as_deref() == Some(turn_id)).filter_map(|x| x.sink.clone()).collect();
        for tx in sinks {
            after.sends.push((tx, sse(&kind, &props)));
        }
        match kind.as_str() {
            "message.completed" | "message.aborted" => end_turn(w, turn_id, Ok(props), after),
            "error" => end_turn(w, turn_id, Err(props["error"].as_str().unwrap_or("the reply failed").to_string()), after),
            _ => {}
        }
    }
}

/// `resolve`, boxed: it and `After::run` call each other, so one of them names its future's type.
fn resolve_later(st: AppState, proxy: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move { resolve(&st, &proxy).await })
}

/// After an idle (or a gap): the turns still open here are looked up there; a finished one ends.
async fn resolve(st: &AppState, proxy: &str) {
    let Some((root, rid, ids)) = ({
        let w = st.relay.watches.lock().unwrap();
        w.get(proxy).map(|x| (x.root.clone(), x.rid.clone(), x.turns.iter().filter_map(|t| t.turn_id.clone()).collect::<Vec<_>>()))
    }) else {
        return;
    };
    let Some(first) = ids.first() else { return };
    let Ok(msgs) = crate::peers::call(st, &root, "GET", &format!("/session/{rid}/message?from={first}&internal=1"), None, 30).await else { return };
    let mut after = After::default();
    {
        let mut ws = st.relay.watches.lock().unwrap();
        let Some(w) = ws.get_mut(proxy) else { return };
        for id in &ids {
            let reply = msgs.as_array().into_iter().flatten().find(|m| m["info"]["role"] == "assistant" && m["info"]["parentID"] == id.as_str() && m["info"]["time"]["completed"].is_number());
            if let Some(m) = reply {
                let mut m = m.clone();
                rewrite(&mut m, &rid, proxy);
                let r = if m["info"]["error"]["name"] == "UnknownError" { Err(m["info"]["error"]["data"]["message"].as_str().unwrap_or("the reply failed").to_string()) } else { Ok(m) };
                end_turn(w, id, r, &mut after);
            }
        }
        if w.turns.is_empty() && w.current.is_none() {
            release(st, w, proxy);
        }
    }
    after.run(st).await;
}

/// The card says it, the phone's page and the voice agent get an error, the proxy goes idle.
fn link_lost(st: &AppState, root: &str) {
    let mut after = After::default();
    let mut idle = vec![];
    {
        let mut ws = st.relay.watches.lock().unwrap();
        for (proxy, w) in ws.iter_mut().filter(|(_, w)| w.root == root) {
            if w.turns.is_empty() && w.busy.is_none() {
                continue;
            }
            let why = format!("no answer from {root}");
            for mut t in w.turns.drain(..) {
                if let Some(tx) = t.sink.take() {
                    after.sends.push((tx, Event::default().event("error").json_data(json!({ "sessionID": proxy, "error": why })).unwrap_or_default()));
                }
                if let Some(d) = t.done.take() {
                    let _ = d.send(Err(why.clone()));
                }
            }
            w.current = None;
            w.early.clear();
            release(st, w, proxy);
            if !w.lost {
                w.lost = true;
                idle.push((proxy.clone(), why));
            }
        }
    }
    for (proxy, why) in idle {
        eprintln!("relay: {proxy}: {why}");
        publish(st, "error", json!({ "sessionID": proxy, "error": why }));
        publish(st, "session.idle", json!({ "sessionID": proxy }));
        card_says(st, &proxy, &why);
    }
    let st = st.clone();
    tokio::spawn(async move { after.run(&st).await });
}

fn card_says(st: &AppState, proxy: &str, why: &str) {
    let info = with_session(st, proxy, |s| {
        if !s.info["card"].is_object() {
            s.info["card"] = json!({});
        }
        s.info["card"]["status"] = json!("failed");
        s.info["card"]["headline"] = json!(why);
        s.info["card"]["updated"] = json!(now_ms());
        s.info.clone()
    });
    if let Some(info) = info {
        publish(st, "session.updated", json!({ "info": info }));
    }
}

/// One follower per root: long-polls its feed for the watched proxies, republishes, notices a
/// dropped link. Ends when nothing on that root is watched.
async fn follow(st: AppState, root: String, fo: Arc<Follower>) {
    let (mut after, mut epoch): (Option<u64>, Option<String>) = (None, None);
    let mut last_ok = now_ms();
    let mut fails = 0u32;
    loop {
        let rids: Vec<String> = {
            let mut ws = st.relay.watches.lock().unwrap();
            let now = now_ms();
            ws.retain(|_, w| w.root != root || !w.turns.is_empty() || w.busy.is_some() || w.view_until > now);
            let rids: Vec<String> = ws.values().filter(|w| w.root == root).map(|w| w.rid.clone()).collect();
            if rids.is_empty() {
                st.relay.followers.lock().unwrap().remove(&root);
                return;
            }
            rids
        };
        let wait = if after.is_some() { FEED_WAIT_S } else { 0 };
        let body = json!({ "after": after, "epoch": epoch, "sessions": rids, "wait": wait });
        let changed = fo.changed.notified();
        let r = tokio::select! {
            r = crate::peers::call(&st, &root, "POST", "/event/feed", Some(body), wait + 20) => r,
            _ = changed => continue,
        };
        match r {
            Ok(v) => {
                fails = 0;
                last_ok = now_ms();
                let fresh = epoch.as_deref() != v["epoch"].as_str();
                epoch = v["epoch"].as_str().map(String::from);
                let first = after.is_none();
                after = v["seq"].as_u64().or(after);
                if first {
                    fo.primed.store(true, Ordering::SeqCst);
                    fo.primed_bell.notify_waiters();
                }
                let busy: HashSet<String> = v["busy"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect();
                let mut post = After::default();
                {
                    let mut ws = st.relay.watches.lock().unwrap();
                    for ev in v["events"].as_array().cloned().unwrap_or_default() {
                        let Some(rid) = session_of(&ev) else { continue };
                        let Some((proxy, w)) = ws.iter_mut().find(|(_, w)| w.root == root && w.rid == rid) else { continue };
                        let proxy = proxy.clone();
                        on_event(&st, &proxy, w, ev, &mut post);
                    }
                    let gap = v["gap"] == true || (fresh && !first);
                    let mut look = vec![];
                    for (proxy, w) in ws.iter_mut().filter(|(_, w)| w.root == root) {
                        if w.lost {
                            w.lost = false;
                        }
                        // the other root's own word on busy: a turn it runs that this root did
                        // not start shows busy here too; one that ended unseen goes idle
                        if busy.contains(&w.rid) {
                            mark_busy(&st, w, proxy);
                        } else if w.busy.is_some() && w.turns.is_empty() && (first || gap || v["events"].as_array().is_none_or(|e| e.is_empty())) {
                            w.current = None;
                            release(&st, w, proxy);
                            publish(&st, "session.idle", json!({ "sessionID": proxy }));
                        }
                        if gap && !w.turns.is_empty() {
                            look.push(proxy.clone());
                        }
                    }
                    drop(ws);
                    for p in look {
                        tokio::spawn(resolve_later(st.clone(), p));
                    }
                }
                post.run(&st).await;
            }
            Err(e) => {
                fails += 1;
                if fails == 1 || fails % 10 == 0 {
                    eprintln!("relay: feed of {root}: {e}");
                }
                if now_ms().saturating_sub(last_ok) >= lost_ms() {
                    link_lost(&st, &root);
                }
                tokio::time::sleep(Duration::from_secs(fails.min(5) as u64)).await;
            }
        }
    }
}

/// How a client of a forwarded turn wants its answer.
pub enum Wants {
    Async,
    Sse,
    Plain,
}

pub struct Forwarded {
    pub turn_id: String,
    pub stream: Option<mpsc::Receiver<Event>>,
    pub done: Option<oneshot::Receiver<Result<Value, String>>>,
}

/// "no answer from lab" when the line or the root is down; the root's own words otherwise.
pub fn no_answer(root: &str, e: &str) -> String {
    if e.contains("unreachable") || e.contains(": 502 ") || e.contains(": 503 ") || e.contains(": 504 ") || e.contains("timed out") {
        format!("no answer from {root}")
    } else {
        e.to_string()
    }
}

/// Posts a turn to the other root's session without waiting for its end, and follows it there.
/// `meta`: what rides along (`from`, `auto`, `internal`); a key is added, so a post sent twice
/// runs once.
pub async fn forward(st: &AppState, proxy: &str, root: &str, rid: &str, parts: Vec<Value>, modality: Option<String>, meta: Value, wants: Wants) -> Result<Forwarded, String> {
    let (sink, stream) = match wants {
        Wants::Sse => {
            let (tx, rx) = mpsc::channel::<Event>(256);
            (Some(tx), Some(rx))
        }
        _ => (None, None),
    };
    let (done_tx, done) = match wants {
        Wants::Plain => {
            let (tx, rx) = oneshot::channel();
            (Some(tx), Some(rx))
        }
        _ => (None, None),
    };
    let fo = {
        let mut ws = st.relay.watches.lock().unwrap();
        watch_locked(st, &mut ws, proxy, root, rid, false);
        let w = ws.get_mut(proxy).unwrap();
        w.turns.push(PendingTurn { turn_id: None, sink, done: done_tx });
        w.lost = false;
        mark_busy(st, w, proxy);
        st.relay.followers.lock().unwrap().get(root).cloned()
    };
    // the follower must know where the other root's events stand before the turn makes any
    if let Some(fo) = fo {
        let ready = fo.primed_bell.notified();
        if !fo.primed.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(Duration::from_secs(10), ready).await;
        }
    }
    let mut meta = if meta.is_object() { meta } else { json!({}) };
    meta["key"] = json!(uuid::Uuid::new_v4().simple().to_string());
    let mut body = json!({ "parts": crate::files::outgoing(st, &parts), "meta": meta });
    if let Some(m) = modality {
        body["modality"] = json!(m);
    }
    let path = format!("/session/{rid}/message?async=1&origin=none");
    let mut r = crate::peers::call(st, root, "POST", &path, Some(body.clone()), 30).await;
    if let Err(e) = &r {
        // the post may have arrived and its answer got lost: the key makes a second one safe
        if !e.contains(": 4") {
            tokio::time::sleep(Duration::from_secs(2)).await;
            r = crate::peers::call(st, root, "POST", &path, Some(body), 30).await;
        }
    }
    let mut after = After::default();
    let out = {
        let mut ws = st.relay.watches.lock().unwrap();
        let Some(w) = ws.get_mut(proxy) else { return Err("the session was removed".into()) };
        // our turn is the newest one without an id
        let i = w.turns.iter().rposition(|t| t.turn_id.is_none());
        match (&r, i) {
            (Ok(v), Some(i)) if v["turn_id"].is_string() => {
                let tid = v["turn_id"].as_str().unwrap().to_string();
                w.turns[i].turn_id = Some(tid.clone());
                flush_early(w, &tid, &mut after);
                Ok(tid)
            }
            (_, i) => {
                if let Some(i) = i {
                    w.turns.remove(i);
                }
                let e = match &r {
                    Ok(v) => format!("{root} did not take the message: {v}"),
                    Err(e) => no_answer(root, e),
                };
                if w.turns.is_empty() {
                    release(st, w, proxy);
                    publish(st, "session.idle", json!({ "sessionID": proxy }));
                }
                Err(e)
            }
        }
    };
    after.run(st).await;
    match out {
        Ok(turn_id) => Ok(Forwarded { turn_id, stream, done }),
        Err(e) => {
            card_says(st, proxy, &e);
            Err(e)
        }
    }
}

/// Cancel, forwarded. When the other root does not answer, the turns end here anyway.
async fn forward_abort(st: &AppState, proxy: &str, root: &str, rid: &str) {
    match crate::peers::call(st, root, "POST", &format!("/session/{rid}/abort"), None, 15).await {
        Ok(_) => eprintln!("relay: abort of {proxy} forwarded to {root}"),
        Err(e) => {
            let why = no_answer(root, &e);
            eprintln!("relay: abort of {proxy}: {why}");
            let mut after = After::default();
            {
                let mut ws = st.relay.watches.lock().unwrap();
                if let Some(w) = ws.get_mut(proxy) {
                    for t in w.turns.drain(..) {
                        let id = t.turn_id.clone().unwrap_or_default();
                        let msg = json!({ "info": { "id": crate::new_id("msg"), "sessionID": proxy, "role": "assistant", "parentID": id,
                            "time": { "created": now_ms(), "completed": now_ms() },
                            "error": { "name": "MessageAbortedError", "data": { "message": format!("stopped here — {why}") } } },
                            "parts": [{ "type": "text", "text": "" }] });
                        if let Some(tx) = &t.sink {
                            after.sends.push((tx.clone(), sse("message.aborted", &msg)));
                        }
                        after.ends.push((t, Ok(msg)));
                    }
                    w.current = None;
                    release(st, w, proxy);
                }
            }
            publish(st, "session.idle", json!({ "sessionID": proxy }));
            card_says(st, proxy, &why);
            after.run(st).await;
        }
    }
}

/// `POST /session/{proxy}/abort` when no turn of it is followed here: asked there directly.
pub async fn abort_remote(st: &AppState, root: &str, rid: &str) -> Result<bool, String> {
    crate::peers::call(st, root, "POST", &format!("/session/{rid}/abort"), None, 15).await.map(|v| v == json!(true)).map_err(|e| no_answer(root, &e))
}

/// A proxy deleted here: stop following it (its clients get the end).
pub fn forget(st: &AppState, proxy: &str) {
    let w = st.relay.watches.lock().unwrap().remove(proxy);
    if let Some(mut w) = w {
        release(st, &mut w, proxy);
        for mut t in w.turns.drain(..) {
            t.sink = None;
            if let Some(d) = t.done.take() {
                let _ = d.send(Err("the session was removed".into()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(evs: &[(&str, &str)]) -> Journal {
        let mut j = Journal { epoch: "e1".into(), seq: 0, ring: VecDeque::new(), bytes: 0 };
        for (sid, kind) in evs {
            j.seq += 1;
            j.ring.push_back((j.seq, sid.to_string(), 10, json!({ "type": kind, "properties": { "sessionID": sid } })));
        }
        j
    }

    #[test]
    fn feed_answers_only_the_asked_sessions_after_the_point() {
        let jr = j(&[("a", "x"), ("b", "y"), ("a", "z")]);
        let set: HashSet<String> = ["a".to_string()].into();
        // first ask: where it stands, nothing else
        assert_eq!(collect(&jr, None, None, &set), (3, false, vec![]));
        let (next, gap, evs) = collect(&jr, Some("e1"), Some(0), &set);
        assert_eq!((next, gap), (3, false));
        assert_eq!(evs.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), vec!["x", "z"]);
        assert_eq!(evs[1]["seq"], 3);
        assert!(collect(&jr, Some("e1"), Some(3), &set).2.is_empty());
        // another epoch (the root restarted): a gap, from where it stands now
        assert_eq!(collect(&jr, Some("e0"), Some(2), &set), (3, true, vec![]));
    }

    #[test]
    fn feed_says_gap_when_the_ring_moved_past_the_point() {
        let mut jr = j(&[("a", "1"), ("a", "2"), ("a", "3")]);
        jr.ring.pop_front();
        let set: HashSet<String> = ["a".to_string()].into();
        let (_, gap, evs) = collect(&jr, Some("e1"), Some(0), &set);
        assert!(gap);
        assert_eq!(evs.len(), 2);
        let (_, gap, _) = collect(&jr, Some("e1"), Some(1), &set);
        assert!(!gap);
    }

    #[test]
    fn events_name_their_session_and_take_the_proxy_id() {
        assert_eq!(session_of(&json!({ "type": "message.part.delta", "properties": { "sessionID": "s1", "text": "hi" } })).as_deref(), Some("s1"));
        assert_eq!(session_of(&json!({ "type": "message.updated", "properties": { "info": { "sessionID": "s2" } } })).as_deref(), Some("s2"));
        assert_eq!(session_of(&json!({ "type": "message.part.updated", "properties": { "part": { "sessionID": "s3" } } })).as_deref(), Some("s3"));
        assert_eq!(session_of(&json!({ "type": "session.updated", "properties": { "info": { "id": "s4" } } })).as_deref(), Some("s4"));
        assert_eq!(session_of(&json!({ "type": "tree.updated", "properties": {} })), None);
        let mut v = json!({ "sessionID": "r1", "info": { "sessionID": "r1", "parentID": "msg_1", "id": "msg_2" }, "list": ["r1", "x"] });
        rewrite(&mut v, "r1", "p1");
        assert_eq!(v, json!({ "sessionID": "p1", "info": { "sessionID": "p1", "parentID": "msg_1", "id": "msg_2" }, "list": ["p1", "x"] }));
    }

    #[test]
    fn a_dropped_line_reads_as_no_answer() {
        assert_eq!(no_answer("lab", "root lab unreachable: error sending request"), "no answer from lab");
        assert_eq!(no_answer("lab", "root lab: 504 Gateway Timeout {}"), "no answer from lab");
        assert_eq!(no_answer("lab", "root lab: 400 Bad Request {\"error\":\"no text or file parts\"}"), "root lab: 400 Bad Request {\"error\":\"no text or file parts\"}");
    }
}
