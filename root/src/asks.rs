//! The requests board: every owner ask is one card.
//!
//! An *ask* is a turn the owner typed or said: a `user` message in a top-level session that
//! carries no `meta.from` (another session wrote it), `meta.auto` (a verdict request),
//! `meta.internal` (station traffic) or `meta.resent_of` (a re-send after a restart). Nothing is
//! copied: the list is read from the sessions each time, so the owner's words are exactly the
//! stored words. The only thing this module stores is what the sessions cannot say — which
//! session owns the work and which branch + commit it landed in — in `<data>/asks.json`
//! (`{ "<message id>": { session, branch, commit, note } }`, written atomically).
//!
//! `GET /asks[?limit=N]` → newest first. `POST /asks/{id}` `{session?, branch?, commit?, note?}`
//! sets the owner and/or the git ref (an empty string clears a field). No existing route changes.
//!
//! STATUS RULES (one place, `status()`; plain words for the phone):
//!   - the *owner* of an ask is the session set by POST, else the session it was typed in;
//!   - `running`  the owner is busy AND something happened in its transcript in the last 15 min
//!                (its last message/tool part, or the harness transcript file's mtime) — a session
//!                can be "busy" with nothing running, that is `stalled`;
//!   - `stalled`  the owner is busy and nothing happened for more than 15 min;
//!   - `blocked`  not busy, no landed ref, and its last report has a line that starts with
//!                `QUESTION:` or "blocked", or the owner's card `needs` is non-empty;
//!   - `done`     not busy and a branch AND a commit are recorded;
//!   - `answered` not busy, no ref, a reply came (a question, a status — nothing to land);
//!   - `asked`    not busy, no ref, no reply yet.
//!   A session typed in (MAIN) is busy for *its latest ask only*: older asks it already replied
//!   to are not "running" just because MAIN is working on a newer one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Value, json};

use crate::{AppState, Session, bad_request, message_text, not_found};

/// Busy with no activity for longer than this = stalled.
pub const STALL_MS: u64 = 15 * 60 * 1000;

static WRITE: Mutex<()> = Mutex::new(());

/// One ask read from a session.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask {
    pub id: String,
    pub session: String,
    pub text: String,
    pub created: u64,
    /// the text of the assistant turn that answered it (parentID = this ask, completed); empty
    /// for a folded turn, whose words were dropped — it still counts as answered
    pub reply: Option<String>,
    /// no later owner ask in the same session has been typed
    pub latest_in_session: bool,
}

/// Is this user message something the owner said?
pub fn is_owner_turn(m: &Value) -> bool {
    let i = &m["info"];
    if i["role"] != "user" {
        return false;
    }
    let meta = &i["meta"];
    if meta["from"].is_object() || meta["auto"] == true || meta["internal"] == true || !meta["resent_of"].is_null() {
        return false;
    }
    let t = message_text(m);
    let t = t.trim();
    // the sims' probes ("Reply with exactly: …") are not asks
    !t.is_empty() && !t.starts_with("Reply with exactly:")
}

/// Every owner ask, newest first (top-level sessions only: a sub-session's user turns are a
/// session talking, not the owner).
pub fn collect(sessions: &HashMap<String, Session>) -> Vec<Ask> {
    let mut out = Vec::new();
    for (sid, s) in sessions {
        if !s.info["parentID"].is_null() || s.info["archived"] == true && s.messages.is_empty() {
            continue;
        }
        let first = out.len();
        for (n, m) in s.messages.iter().enumerate() {
            if !is_owner_turn(m) {
                continue;
            }
            let id = m["info"]["id"].as_str().unwrap_or_default().to_string();
            // the reply is the next assistant turns up to the next owner turn: its own text
            let reply = s.messages[n + 1..]
                .iter()
                .take_while(|r| r["info"]["role"] != "user" || !is_owner_turn(r))
                .filter(|r| r["info"]["role"] == "assistant" && r["info"]["parentID"] == m["info"]["id"])
                .filter(|r| r["info"]["time"]["completed"].is_number())
                .map(message_text)
                .last();
            out.push(Ask {
                id,
                session: sid.clone(),
                text: message_text(m).trim().to_string(),
                created: m["info"]["time"]["created"].as_u64().unwrap_or(0),
                reply,
                latest_in_session: false,
            });
        }
        if let Some(last) = out[first..].iter_mut().max_by_key(|a| a.created) {
            last.latest_in_session = true;
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.created));
    out
}

/// What `status()` needs to know about an ask.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub busy: bool,
    /// the last time anything moved in the owner's transcript (ms), if known
    pub last_active: Option<u64>,
    /// the owner's last report (a reply, a final message)
    pub report: String,
    /// card `needs` of the owner session
    pub needs: String,
    pub has_ref: bool,
    pub replied: bool,
    pub now: u64,
}

/// A report that asks the owner something or says it is blocked.
pub fn report_blocks(report: &str, needs: &str) -> bool {
    if !needs.trim().is_empty() {
        return true;
    }
    if report.lines().any(|l| l.trim_start().starts_with("QUESTION:")) {
        return true;
    }
    // "says blocked" = a line that opens with it ("Blocked: rig lock"); a status that merely
    // mentions another thing being blocked is not this ask being blocked
    report.lines().any(|l| l.trim_start().trim_start_matches(['*', '#', '-', ' ']).to_lowercase().starts_with("blocked"))
}

/// (status, a plain-words reason) — see the rules at the top of the file.
pub fn status(f: &Facts) -> (&'static str, String) {
    if f.busy {
        let age = f.last_active.map(|t| f.now.saturating_sub(t));
        return match age {
            Some(a) if a <= STALL_MS => ("running", format!("working now · last activity {}", ago(a))),
            Some(a) => ("stalled", format!("busy but nothing has happened for {}", ago(a))),
            None => ("stalled", "busy but nothing has happened yet".into()),
        };
    }
    if f.has_ref {
        return ("done", "finished and landed".into());
    }
    if report_blocks(&f.report, &f.needs) {
        return ("blocked", "waiting on an answer or a fix".into());
    }
    if f.replied {
        ("answered", "answered, nothing to land".into())
    } else {
        ("asked", "not picked up yet".into())
    }
}

fn ago(ms: u64) -> String {
    let m = ms / 60_000;
    match m {
        0 => "under a minute".into(),
        1..=59 => format!("{m} min"),
        _ => format!("{} h", m / 60),
    }
}

// ───────────────────────── store ─────────────────────────

fn store_path(dir: &Path) -> PathBuf {
    dir.join("asks.json")
}

pub fn read_store(dir: &Path) -> serde_json::Map<String, Value> {
    std::fs::read_to_string(store_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_store(dir: &Path, m: &serde_json::Map<String, Value>) -> std::io::Result<()> {
    let p = store_path(dir);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(m).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, &p)
}

fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Latest activity of a session's transcript as the brain keeps it (ms).
fn session_activity(s: &Session) -> u64 {
    let mut t = s.info["time"]["updated"].as_u64().unwrap_or(0);
    for m in s.messages.iter().rev().take(6) {
        let mi = &m["info"]["time"];
        t = t.max(mi["created"].as_u64().unwrap_or(0)).max(mi["completed"].as_u64().unwrap_or(0));
        for p in m["parts"].as_array().into_iter().flatten() {
            let pt = &p["state"]["time"];
            t = t.max(pt["start"].as_u64().unwrap_or(0)).max(pt["end"].as_u64().unwrap_or(0));
        }
    }
    t
}

/// A claude harness keeps its own transcript; a session can show busy while that file is
/// silent. Its mtime is the harness's real last activity (ms).
fn harness_activity(s: &Session) -> u64 {
    let Some(hid) = s.info["harness"]["id"].as_str().filter(|h| h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) else {
        return 0;
    };
    let Some(home) = std::env::var_os("HOME") else { return 0 };
    let root = PathBuf::from(home).join(".claude/projects");
    let mut best = 0;
    for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if let Ok(md) = std::fs::metadata(d.path().join(format!("{hid}.jsonl")))
            && let Ok(t) = md.modified()
            && let Ok(t) = t.duration_since(std::time::UNIX_EPOCH)
        {
            best = best.max(t.as_millis() as u64);
        }
    }
    best
}

fn last_assistant_text(s: &Session) -> String {
    s.messages
        .iter()
        .rev()
        .filter(|m| m["info"]["role"] == "assistant" && !crate::is_internal(m))
        .map(message_text)
        .find(|t| !t.trim().is_empty())
        .unwrap_or_default()
}

/// The card rows, newest first.
pub fn board(st: &AppState, limit: usize) -> Vec<Value> {
    let store = read_store(&st.data_dir);
    let now = crate::now_ms();
    let sessions = st.sessions.lock().unwrap();
    let running = st.running.lock().unwrap();
    let mut asks = collect(&sessions);
    asks.truncate(limit);
    let title = |id: &str| sessions.get(id).and_then(|s| s.info["title"].as_str()).unwrap_or("").to_string();
    asks.into_iter()
        .map(|a| {
            let rec = store.get(&a.id).cloned().unwrap_or(Value::Null);
            let owner = rec["session"].as_str().filter(|s| sessions.contains_key(*s)).unwrap_or(&a.session).to_string();
            let own = owner == a.session;
            let branch = rec["branch"].as_str().unwrap_or("").to_string();
            let commit = rec["commit"].as_str().unwrap_or("").to_string();
            let o = &sessions[&owner];
            let mut f = Facts { now, has_ref: !branch.is_empty() && !commit.is_empty(), ..Facts::default() };
            if own {
                // typed in the owner session: busy only for its latest ask, report = its own reply
                f.busy = running.contains_key(&owner) && a.latest_in_session && a.reply.is_none();
                f.replied = a.reply.is_some();
                f.report = a.reply.clone().unwrap_or_default();
            } else {
                f.busy = running.contains_key(&owner);
                let last = o.messages.iter().rev().find(|m| m["info"]["role"] == "assistant");
                f.replied = last.is_some_and(|m| m["info"]["time"]["created"].as_u64().unwrap_or(0) >= a.created);
                f.report = last_assistant_text(o);
                f.needs = o.info["card"]["needs"].as_str().unwrap_or("").to_string();
            }
            let act = session_activity(o).max(if f.busy { harness_activity(o) } else { 0 });
            f.last_active = (act > 0).then_some(act);
            let (status, why) = status(&f);
            json!({
                "id": a.id, "text": a.text, "created": a.created,
                "home": { "id": a.session, "title": title(&a.session) },
                "session": { "id": owner, "title": title(&owner) },
                "status": status, "why": why,
                "branch": branch, "commit": commit,
                "note": rec["note"].as_str().unwrap_or(""),
                "updated": act,
            })
        })
        .collect()
}

// ───────────────────────── routes ─────────────────────────

/// `GET /asks[?limit=N]` — the board, newest ask first.
pub async fn get_asks(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let limit = q.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(300).clamp(1, 2000);
    Json(Value::Array(board(&st, limit)))
}

/// `POST /asks/{id}` — `{session?, branch?, commit?, note?}`; "" clears. 404 when `id` is not an
/// owner ask, 400 for a session that does not exist or a commit that is not a hex sha.
pub async fn set_ask(State(st): State<AppState>, UrlPath(id): UrlPath<String>, Json(body): Json<Value>) -> Response {
    {
        let sessions = st.sessions.lock().unwrap();
        if !collect(&sessions).iter().any(|a| a.id == id) {
            return not_found(&id);
        }
        if let Some(s) = body["session"].as_str().filter(|s| !s.is_empty())
            && !sessions.contains_key(s)
        {
            return bad_request("unknown session");
        }
    }
    if let Some(c) = body["commit"].as_str().filter(|c| !c.is_empty())
        && !is_sha(c)
    {
        return bad_request("commit must be a hex sha");
    }
    for k in ["branch", "note"] {
        if body[k].as_str().is_some_and(|v| v.len() > 300) {
            return bad_request("too long");
        }
    }
    let _g = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_store(&st.data_dir);
    let mut rec = store.get(&id).cloned().unwrap_or_else(|| json!({}));
    for k in ["session", "branch", "commit", "note"] {
        match body[k].as_str() {
            Some("") => {
                rec.as_object_mut().unwrap().remove(k);
            }
            Some(v) => rec[k] = json!(v.trim()),
            None => {}
        }
    }
    store.insert(id.clone(), rec.clone());
    if let Err(e) = write_store(&st.data_dir, &store) {
        eprintln!("asks: write: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "could not save" }))).into_response();
    }
    Json(rec).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn umsg(id: &str, text: &str, t: u64, meta: Value) -> Value {
        json!({ "info": { "id": id, "role": "user", "time": { "created": t }, "meta": meta }, "parts": [{ "type": "text", "text": text }] })
    }
    fn amsg(id: &str, parent: &str, text: &str, t: u64) -> Value {
        json!({ "info": { "id": id, "role": "assistant", "parentID": parent, "time": { "created": t, "completed": t + 5 } }, "parts": [{ "type": "text", "text": text }] })
    }
    fn sess(parent: Value, messages: Vec<Value>) -> Session {
        Session { info: json!({ "parentID": parent, "title": "t" }), messages, todo: vec![], inbox: vec![] }
    }

    #[test]
    fn owner_turns_only() {
        let mut m = HashMap::new();
        m.insert(
            "ses_a".to_string(),
            sess(
                Value::Null,
                vec![
                    umsg("m1", "  build me a board ", 100, json!({ "digest": "x" })),
                    amsg("r1", "m1", "on it", 110),
                    umsg("m2", "from a session", 120, json!({ "from": { "session": "s" } })),
                    umsg("m3", "verdict", 130, json!({ "auto": true })),
                    umsg("m4", "station", 140, json!({ "internal": true })),
                    umsg("m5", "again", 150, json!({ "resent_of": "m1" })),
                    umsg("m6", "Reply with exactly: copy-1", 160, json!({})),
                    umsg("m7", "status?", 170, json!({})),
                ],
            ),
        );
        m.insert("ses_child".to_string(), sess(json!("ses_a"), vec![umsg("c1", "child", 200, json!({}))]));
        let asks = collect(&m);
        assert_eq!(asks.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["m7", "m1"]);
        assert_eq!(asks[1].text, "build me a board", "exact words, trimmed");
        assert_eq!(asks[1].reply.as_deref(), Some("on it"));
        assert!(asks[0].latest_in_session && !asks[1].latest_in_session);
        assert!(asks[0].reply.is_none());
    }

    #[test]
    fn folded_reply_still_answers() {
        let mut m = HashMap::new();
        m.insert("s".to_string(), sess(Value::Null, vec![umsg("m1", "Status?", 1, json!({})), amsg("r1", "m1", "", 2)]));
        assert_eq!(collect(&m)[0].reply.as_deref(), Some(""));
    }

    fn f() -> Facts {
        Facts { now: 10_000_000, ..Facts::default() }
    }

    #[test]
    fn running_stalled() {
        let mut x = f();
        x.busy = true;
        x.last_active = Some(x.now - 60_000);
        assert_eq!(status(&x).0, "running");
        x.last_active = Some(x.now - STALL_MS); // exactly 15 min: still running
        assert_eq!(status(&x).0, "running");
        x.last_active = Some(x.now - STALL_MS - 1);
        assert_eq!(status(&x).0, "stalled");
        x.last_active = None;
        assert_eq!(status(&x).0, "stalled");
        // busy outranks everything: a landed ref does not stop a session that still works
        x.has_ref = true;
        x.last_active = Some(x.now);
        assert_eq!(status(&x).0, "running");
    }

    #[test]
    fn done_blocked_answered_asked() {
        let mut x = f();
        assert_eq!(status(&x).0, "asked");
        x.replied = true;
        assert_eq!(status(&x).0, "answered");
        x.report = "all fine\nQUESTION: ship it?".into();
        assert_eq!(status(&x).0, "blocked");
        x.report = "Blocked: the rig lock is stuck".into();
        assert_eq!(status(&x).0, "blocked");
        x.report = "I am blocked on the rig lock".into();
        assert_eq!(status(&x).0, "answered");
        x.report = "the lock is unblocked now".into();
        assert_eq!(status(&x).0, "answered");
        x.report.clear();
        x.needs = "your OK".into();
        assert_eq!(status(&x).0, "blocked");
        x.has_ref = true; // a landed ref wins over an old question
        assert_eq!(status(&x).0, "done");
    }

    #[test]
    fn sha_check() {
        assert!(is_sha("b024e076") && is_sha(&"a".repeat(40)));
        assert!(is_sha("b024e07") && !is_sha("zzzzzzzz") && !is_sha("abc") && !is_sha(&"a".repeat(41)));
    }

    #[test]
    fn store_roundtrip() {
        let d = std::env::temp_dir().join(format!("asks-{}", crate::new_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        assert!(read_store(&d).is_empty());
        let mut m = serde_json::Map::new();
        m.insert("m1".into(), json!({ "branch": "b", "commit": "abcdef1" }));
        write_store(&d, &m).unwrap();
        assert_eq!(read_store(&d)["m1"]["commit"], "abcdef1");
        std::fs::remove_dir_all(&d).ok();
    }
}
