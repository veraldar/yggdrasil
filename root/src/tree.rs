//! The tree (root-coord, 11-12): sessions managing sessions.
//!
//! The coordinator ([MAIN]) is the user's one door. It starts, continues, reads and closes
//! sessions with five native tools; a `lead` session can do the same below itself, so the tree
//! nests as deep as the work needs (guarded by YGG_TREE_MAX_DEPTH / YGG_TREE_MAX_CHILDREN).
//!
//! Every session under a managing parent carries a CARD on its info (`info.card`: topic, brief,
//! status, headline, summary, needs, updated). When one of its turns ends, a one-shot DIGEST
//! call (no session, no history) rewrites the card and files an EVENT in the parent's INBOX
//! (`Session.inbox`) — never a turn in the parent's transcript. Then:
//! - a lead parent is WOKEN with an internal turn carrying the reports (it continues its loop);
//! - the coordinator is woken (debounced) only for reports that matter to the user, and its
//!   reply is MAIN coming back to the user; `(quiet)` replies are hidden;
//! - everything else waits in the inbox and rides the coordinator's next owner turn as
//!   `[inbox since your last turn]` lines (frozen on that message — cache law).
//! The coordinator's latest turn also sees a live `[tree]` view of the cards.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::{AppState, Session, Turn, message_text, new_id, now_ms, publish, text_part, with_session};

pub struct TreeCfg {
    pub max_depth: usize,
    pub max_children: usize,
    /// one-shot digest model (thinking off); `None` = the brain's default model
    pub digest_model: Option<String>,
    pub wake_debounce_ms: u64,
    /// internal wake turns one session may receive before the tree stops waking it
    pub max_wakes: u64,
}

const INBOX_CAP: usize = 300;

/// The tree tools; `session_start` lists the profiles this root offers (built at startup from
/// the profile set, so the bytes are constant for the process — cache law).
pub fn schemas(profiles: &crate::profiles::Profiles) -> Vec<Value> {
    let offer: Vec<String> = profiles
        .by_name
        .values()
        .filter(|p| p.name != "coordinator")
        .map(|p| format!("{}: {}", p.name, p.description))
        .collect();
    fn f(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
        json!({ "type": "function", "function": {
            "name": name, "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        }})
    }
    let s = |d: &str| json!({ "type": "string", "description": d });
    vec![
        f("sessions_find", "Find sessions by topic or project (ranked by relevance and recency) before starting a new one. Returns id, title, profile, status and the card headline. The owner's own terminal sessions on this box (Claude Code, Antigravity, opencode) are listed too, with ids term:…",
          json!({ "query": s("words describing the topic, project or task"), "limit": { "type": "integer", "description": "max results (default 8)" },
                  "archived": { "type": "boolean", "description": "include closed sessions" } }), &["query"]),
        f("session_start", "Start a new session under you with a self-contained brief. It works in the background and reports back to you; do not wait for it.",
          json!({ "title": s("short topic title, 2-6 words, unique"), "agent": s(&format!("one of — {}", offer.join(" · "))),
                  "brief": s("self-contained instructions: goal, constraints, paths, what done means, needed facts"),
                  "root": s("optional: another root (machine) to run it on — see the roots line of the [tree] view"),
                  "model": s("optional model id"), "variant": s("optional thinking: high | low | off"),
                  "from": s("optional: start as a COPY of this conversation — a terminal session (term:…) or a session here on Claude Code/opencode/Antigravity — with its whole context; the original is never written (use it when the owner has it open in their terminal)") }), &["title", "agent", "brief"]),
        f("session_send", "Send a message or follow-up instruction to an existing session (its context is kept). It reports back when done. A terminal session (term:…) gets it typed into the owner's terminal when that is possible, else it continues here under you.",
          json!({ "id": s("session id (or exact title)"), "message": s("the message") }), &["id", "message"]),
        f("session_read", "Read a session's card, status, last request, last reply and sub-sessions.",
          json!({ "id": s("session id (or exact title)") }), &["id"]),
        f("session_close", "Cancel and archive a session and its sub-sessions — only when the user cancels or drops that work. Never to tidy up: finished sessions stay in the tree.",
          json!({ "id": s("session id (or exact title)"), "reason": s("why"),
                  "cancel": { "type": "boolean", "description": "true = the user wants it stopped even though it is still running" } }), &["id"]),
    ]
}

pub fn is_tree_tool(name: &str) -> bool {
    matches!(name, "sessions_find" | "session_start" | "session_send" | "session_read" | "session_close")
}

// ── tree geometry ────────────────────────────────────────────────────────────

fn parent_of(s: &Session) -> Option<String> {
    s.info["parentID"].as_str().map(String::from)
}

pub fn depth(sessions: &HashMap<String, Session>, id: &str) -> usize {
    let (mut d, mut cur) = (0usize, id.to_string());
    let mut seen = HashSet::new();
    while let Some(p) = sessions.get(&cur).and_then(parent_of) {
        if !seen.insert(p.clone()) || d > 10_000 {
            break;
        }
        d += 1;
        cur = p;
    }
    d
}

fn children_map(sessions: &HashMap<String, Session>) -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (id, s) in sessions {
        if let Some(p) = parent_of(s) {
            m.entry(p).or_default().push(id.clone());
        }
    }
    m
}

pub fn descendants(sessions: &HashMap<String, Session>, id: &str) -> Vec<String> {
    let kids = children_map(sessions);
    let mut out = Vec::new();
    let mut stack = vec![id.to_string()];
    let mut seen = HashSet::new();
    while let Some(cur) = stack.pop() {
        for k in kids.get(&cur).into_iter().flatten() {
            if seen.insert(k.clone()) {
                out.push(k.clone());
                stack.push(k.clone());
            }
        }
    }
    out
}

fn is_archived(s: &Session) -> bool {
    s.info["archived"] == true
}

fn title_of(s: &Session) -> String {
    s.info["title"].as_str().unwrap_or("untitled").to_string()
}

fn ago(ms: u64) -> String {
    let secs = now_ms().saturating_sub(ms) / 1000;
    if secs < 90 {
        format!("{secs}s")
    } else if secs < 5400 {
        format!("{}m", secs / 60)
    } else if secs < 172_800 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

fn clip(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut out: String = t.chars().take(n).collect();
    out.push('…');
    out
}

fn one_line(s: &str, n: usize) -> String {
    clip(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// `id` may be a session id or an exact (case-insensitive) title.
fn resolve(sessions: &HashMap<String, Session>, key: &str) -> Option<String> {
    let key = key.trim();
    if sessions.contains_key(key) {
        return Some(key.to_string());
    }
    let low = key.to_lowercase();
    sessions
        .iter()
        .filter(|(_, s)| title_of(s).to_lowercase() == low)
        .max_by_key(|(_, s)| s.info["time"]["updated"].as_u64().unwrap_or(0))
        .map(|(id, _)| id.clone())
}

// ── relevance ranking ────────────────────────────────────────────────────────

const STOP: &[&str] = &["the", "and", "for", "with", "that", "this", "from", "into", "about", "what", "make", "have",
    "your", "you", "are", "was", "can", "please", "need", "want", "some", "then", "there", "they", "them", "just"];

pub fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .map(String::from)
        .collect()
}

fn overlap(q: &[String], field: &[String]) -> f64 {
    q.iter()
        .map(|t| {
            if field.iter().any(|f| f == t) {
                1.0
            } else if t.len() >= 4 && field.iter().any(|f| f.starts_with(t.as_str()) || t.starts_with(f.as_str()) && f.len() >= 4) {
                0.6
            } else {
                0.0
            }
        })
        .sum()
}

pub fn score(query: &str, s: &Session) -> f64 {
    let q = tokens(query);
    if q.is_empty() {
        return 0.0;
    }
    let card = &s.info["card"];
    let title = tokens(&title_of(s));
    let topic = tokens(card["topic"].as_str().unwrap_or_default());
    let mut rest = String::new();
    for k in ["brief", "summary", "headline"] {
        rest.push_str(card[k].as_str().unwrap_or_default());
        rest.push(' ');
    }
    let rest = tokens(&rest);
    let raw = 3.0 * overlap(&q, &title) + 2.0 * overlap(&q, &topic) + overlap(&q, &rest);
    if raw <= 0.0 {
        return 0.0;
    }
    let age_h = now_ms().saturating_sub(s.info["time"]["updated"].as_u64().unwrap_or(0)) as f64 / 3_600_000.0;
    let active = matches!(card["status"].as_str(), Some("working" | "blocked"));
    raw / (q.len() as f64).sqrt() + 0.6 * (-age_h / 24.0).exp() + if active { 0.4 } else { 0.0 }
}

// ── the five tools ───────────────────────────────────────────────────────────

pub struct Out {
    pub ok: bool,
    pub output: String,
    pub metadata: Value,
}

fn ok(s: String) -> Out {
    Out { ok: true, output: s, metadata: json!({}) }
}

fn err(s: String) -> Out {
    Out { ok: false, output: s, metadata: json!({}) }
}

/// The caller sees every session (the door) or only its own subtree (a lead).
fn in_scope(st: &AppState, sessions: &HashMap<String, Session>, caller: &str, target: &str) -> bool {
    sees_whole_tree(st, sessions, caller) || descendants(sessions, caller).iter().any(|d| d == target)
}

/// The door sees every session; so does a read-only reader (review), which can only read them.
fn sees_whole_tree(st: &AppState, sessions: &HashMap<String, Session>, caller: &str) -> bool {
    let name = crate::profile_name_of(st, sessions.get(caller).map(|s| &s.info).unwrap_or(&Value::Null));
    name == "coordinator" || crate::agent(st, &name).is_some_and(|p| !p.sessions && p.reads_tree())
}

/// The session a tool call names (`id` = id or exact title) — if the caller may act on it.
fn target_of(st: &AppState, caller: &str, input: &Value) -> Result<String, Out> {
    let sessions = st.sessions.lock().unwrap();
    let t = resolve(&sessions, input["id"].as_str().unwrap_or_default()).ok_or_else(|| err("no such session — use sessions_find".into()))?;
    if t == caller {
        return Err(err("that is you".into()));
    }
    if !in_scope(st, &sessions, caller, &t) {
        return Err(err("not in your subtree".into()));
    }
    Ok(t)
}

pub async fn run(st: &AppState, caller: &str, name: &str, input: &Value) -> Out {
    if let Some(o) = run_terminal(st, caller, name, input).await {
        return o;
    }
    if let Some(o) = run_remote(st, caller, name, input).await {
        return o;
    }
    match name {
        "sessions_find" => find(st, caller, input),
        "session_start" => start(st, caller, input),
        "session_send" => send(st, caller, input),
        "session_read" => read(st, caller, input),
        "session_close" => close(st, caller, input),
        _ => err(format!("unknown tree tool {name}")),
    }
}

/// The tree tools on another root: start there, or act on a proxy (peers.rs). `None` = local.
async fn run_remote(st: &AppState, caller: &str, name: &str, input: &Value) -> Option<Out> {
    let me = st.config.peers.me.clone();
    if name == "session_start" {
        let root = input["root"].as_str().filter(|r| !r.is_empty() && *r != me)?;
        let (title, brief) = (input["title"].as_str().unwrap_or("work"), input["brief"].as_str().unwrap_or_default());
        let profile = crate::profiles::Profiles::resolve(input["agent"].as_str().or(input["profile"].as_str()).unwrap_or("build").trim());
        if brief.trim().is_empty() {
            return Some(err("brief required".into()));
        }
        let title = unique_title(&st.sessions.lock().unwrap(), title);
        return Some(match crate::peers::start(st, caller, root, &title, profile, brief, input["model"].as_str(), input["variant"].as_str()).await {
            Ok(pid) => {
                publish(st, "tree.updated", json!({ "sessionID": pid, "parentID": caller }));
                ok(format!("STARTED, NOT DONE YET: id={pid} \"{title}\" ({profile}) on root {root} reports back when finished. Tell the user it is on its way (→ {title}); never say it is done."))
            }
            Err(e) => err(format!("could not start on {root}: {e}")),
        });
    }
    let target = resolve(&st.sessions.lock().unwrap(), input["id"].as_str().unwrap_or_default())?;
    let (root, rid) = crate::peers::remote_of(st, &target)?;
    if let Err(o) = target_of(st, caller, input) {
        return Some(o);
    }
    Some(match name {
        "session_send" => {
            let msg = input["message"].as_str().unwrap_or_default();
            with_session(st, &target, |s| s.info["card"]["status"] = json!("working"));
            match crate::peers::send(st, &root, &rid, msg).await {
                Ok(()) => ok(format!("SENT, NOT DONE YET: id={target} on root {root} reports back when finished. Tell the user it is on its way; never say it is done.")),
                Err(e) => err(e),
            }
        }
        "session_read" => {
            let local = read(st, caller, input).output;
            match crate::peers::call(st, &root, "GET", &format!("/session/{rid}/message"), None, 20).await {
                Ok(v) => {
                    let last = v.as_array().into_iter().flatten().rev().find(|m| m["info"]["role"] == "assistant").map(message_text).unwrap_or_default();
                    ok(format!("{local}(runs on root {root})\nlast reply there:\n{}", clip(&last, 3000)))
                }
                Err(e) => ok(format!("{local}(runs on root {root}, unreachable now: {e})")),
            }
        }
        "session_close" => {
            let reason = input["reason"].as_str().unwrap_or("closed");
            let _ = crate::peers::call(st, &root, "POST", &format!("/session/{rid}/close"), Some(json!({ "reason": reason })), 15).await;
            archive_family(st, &target, reason);
            ok(format!("closed id={target} (on root {root})"))
        }
        _ => return None,
    })
}

fn card_line(st: &AppState, id: &str, s: &Session, indent: usize) -> String {
    let card = &s.info["card"];
    // live truth first: a run in flight is `running` whatever the last card said
    let running = st.running.lock().unwrap().contains_key(id);
    let status = if running { "running" } else { card["status"].as_str().unwrap_or(if is_archived(s) { "archived" } else { "idle" }) };
    let head = card["headline"].as_str().or(card["summary"].as_str()).or(card["brief"].as_str()).unwrap_or_default();
    let needs = card["needs"].as_str().filter(|n| !n.is_empty()).map(|n| format!(" NEEDS: {}", one_line(n, 160))).unwrap_or_default();
    // where it runs (a proxy: on that root) or who asked for it (a session another root started here)
    let on = s.info["remote"]["root"].as_str().map(|r| format!(" on {r}"))
        .or_else(|| s.info["report_to"]["root"].as_str().map(|r| format!(" for root {r}")))
        .unwrap_or_default();
    format!(
        "{}- \"{}\" [{}{on}, {}, {} ago] {}{} (id={id})",
        "  ".repeat(indent),
        title_of(s),
        crate::profile_name_of(st, &s.info),
        status,
        ago(s.info["time"]["updated"].as_u64().unwrap_or(0)),
        one_line(head, 160),
        needs
    )
}

fn find(st: &AppState, caller: &str, input: &Value) -> Out {
    let query = input["query"].as_str().unwrap_or_default();
    let limit = input["limit"].as_u64().unwrap_or(8).clamp(1, 25) as usize;
    let archived = input["archived"].as_bool().unwrap_or(false);
    let sessions = st.sessions.lock().unwrap();
    let pool: Vec<String> = if sees_whole_tree(st, &sessions, caller) {
        sessions.keys().filter(|k| k.as_str() != caller).cloned().collect()
    } else {
        descendants(&sessions, caller)
    };
    let mut hits: Vec<(f64, String)> = pool
        .into_iter()
        .filter_map(|id| {
            let s = sessions.get(&id)?;
            if is_archived(s) && !archived {
                return None;
            }
            let sc = score(query, s);
            (sc > 0.5).then_some((sc, id))
        })
        .collect();
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    if hits.is_empty() {
        return ok(format!("no session matches {query:?} — start one with session_start"));
    }
    let lines: Vec<String> = hits.iter().filter_map(|(_, id)| sessions.get(id).map(|s| card_line(st, id, s, 0))).collect();
    ok(lines.join("\n"))
}

/// A title unique by slug (the phone resolves sessions by title slug) and never MAIN's.
fn unique_title(sessions: &HashMap<String, Session>, want: &str) -> String {
    let base = one_line(want, 80);
    let base = if base.is_empty() || crate::slug(&base) == "main" { "work".to_string() } else { base };
    let taken: HashSet<String> = sessions.values().map(|s| crate::slug(&title_of(s))).collect();
    if !taken.contains(&crate::slug(&base)) {
        return base;
    }
    (2..).map(|n| format!("{base} {n}")).find(|t| !taken.contains(&crate::slug(t))).unwrap()
}

fn start(st: &AppState, caller: &str, input: &Value) -> Out {
    let Some(brief) = input["brief"].as_str().filter(|b| !b.trim().is_empty()) else { return err("brief required".into()) };
    let raw = input["agent"].as_str().or(input["profile"].as_str()).unwrap_or("build").trim();
    let Some(prof) = crate::agent(st, raw) else {
        let agents = st.config.profiles.read().unwrap();
        let known: Vec<&str> = agents.by_name.keys().map(String::as_str).filter(|n| *n != "coordinator").collect();
        return err(format!("unknown agent {raw:?}; known: {}", known.join(", ")));
    };
    let profile = prof.name;
    if profile == "coordinator" {
        return err("there is one coordinator; pick another agent".into());
    }
    let title = {
        let sessions = st.sessions.lock().unwrap();
        let d = depth(&sessions, caller) + 1;
        if d > st.config.tree.max_depth {
            return err(format!("tree depth limit ({}) reached — do this part yourself", st.config.tree.max_depth));
        }
        let live_kids = children_map(&sessions)
            .get(caller)
            .map(|k| k.iter().filter(|id| sessions.get(*id).is_some_and(|s| !is_archived(s))).count())
            .unwrap_or(0);
        if live_kids >= st.config.tree.max_children {
            return err(format!("{live_kids} open sub-sessions already (limit {}) — close or reuse one", st.config.tree.max_children));
        }
        unique_title(&sessions, input["title"].as_str().unwrap_or("work"))
    };
    let model = input["model"].as_str().filter(|m| !m.is_empty());
    let variant = input["variant"].as_str().filter(|v| !v.is_empty());
    let info = crate::new_session(st, &title, Some(caller), Some(&profile), model, variant);
    let sid = info["id"].as_str().unwrap_or_default().to_string();
    with_session(st, &sid, |s| {
        s.info["card"] = json!({ "topic": title, "brief": clip(brief, 600), "status": "working", "by": caller,
            "created": now_ms(), "updated": now_ms() });
    });
    let turn = Turn { parts: vec![text_part(brief)], modality: None, auto_turn: false, internal: false, origin: Some(caller.to_string()), completes: None };
    if let Err(e) = crate::submit(st, &sid, turn) {
        return err(format!("created {sid} but could not post the brief ({:?})", e.status()));
    }
    publish(st, "tree.updated", json!({ "sessionID": sid, "parentID": caller }));
    ok(format!("STARTED, NOT DONE YET: id={sid} \"{title}\" ({profile}) is starting on it and reports back when finished. Tell the user it is on its way (→ {title}); never say it is done."))
}

fn send(st: &AppState, caller: &str, input: &Value) -> Out {
    let Some(message) = input["message"].as_str().filter(|m| !m.trim().is_empty()) else { return err("message required".into()) };
    let target = match target_of(st, caller, input) {
        Ok(t) => t,
        Err(o) => return o,
    };
    let title = st.sessions.lock().unwrap().get(&target).map(title_of).unwrap_or_default();
    let busy = st.running.lock().unwrap().contains_key(&target);
    with_session(st, &target, |s| {
        if is_archived(s) {
            s.info["archived"] = json!(false);
        }
        s.info["card"]["status"] = json!("working");
        s.info["card"]["updated"] = json!(now_ms());
    });
    let turn = Turn { parts: vec![text_part(message)], modality: None, auto_turn: false, internal: false, origin: Some(caller.to_string()), completes: None };
    match crate::submit(st, &target, turn) {
        Ok(_) => ok(format!(
            "SENT, NOT DONE YET: \"{title}\" (id={target}){} has your instruction and reports back when finished. Tell the user it is on its way (→ {title}); never say it is done.",
            if busy { ", queued behind its current work" } else { "" }
        )),
        Err(e) => err(format!("send failed ({:?})", e.status())),
    }
}

fn read(st: &AppState, caller: &str, input: &Value) -> Out {
    let t = match target_of(st, caller, input) {
        Ok(t) => t,
        Err(o) => return o,
    };
    let sessions = st.sessions.lock().unwrap();
    let Some(s) = sessions.get(&t) else { return err("gone".into()) };
    let busy = st.running.lock().unwrap().contains_key(&t);
    let card = &s.info["card"];
    let last_user = s.messages.iter().rev().find(|m| m["info"]["role"] == "user").map(message_text).unwrap_or_default();
    let last_reply = s
        .messages
        .iter()
        .rev()
        .find(|m| m["info"]["role"] == "assistant" && m["info"]["time"]["completed"].is_number())
        .map(message_text)
        .unwrap_or_default();
    let kids = children_map(&sessions);
    let kid_lines: Vec<String> = kids
        .get(&t)
        .into_iter()
        .flatten()
        .filter_map(|k| sessions.get(k).map(|ks| card_line(st, k, ks, 1)))
        .collect();
    let mut out = format!(
        "\"{}\" (id={t}) profile={} model={} status={}{}\nbrief: {}\nsummary: {}\n",
        title_of(s),
        crate::profile_name_of(st, &s.info),
        s.info["model"]["id"].as_str().unwrap_or("-"),
        card["status"].as_str().unwrap_or("idle"),
        if busy { " (running now)" } else { "" },
        clip(card["brief"].as_str().unwrap_or("-"), 600),
        clip(card["summary"].as_str().unwrap_or("-"), 600),
    );
    if let Some(n) = card["needs"].as_str().filter(|n| !n.is_empty()) {
        out.push_str(&format!("needs: {n}\n"));
    }
    out.push_str(&format!("last request: {}\nlast reply:\n{}\n", clip(&last_user, 500), clip(&last_reply, 3000)));
    if !kid_lines.is_empty() {
        out.push_str(&format!("sub-sessions:\n{}\n", kid_lines.join("\n")));
    }
    ok(out)
}

fn close(st: &AppState, caller: &str, input: &Value) -> Out {
    let target = match target_of(st, caller, input) {
        Ok(t) => t,
        Err(o) => return o,
    };
    let title = st.sessions.lock().unwrap().get(&target).map(title_of).unwrap_or_default();
    if crate::is_main_title(&title) {
        return err("cannot close the coordinator".into());
    }
    // a running family is cancelled only on purpose (sim switch-cancel 11-12: the door closed a
    // session mid-run "to tidy the tree", aborting the work it then called done)
    let busy = {
        let sessions = st.sessions.lock().unwrap();
        let mut fam = descendants(&sessions, &target);
        fam.push(target.clone());
        let running = st.running.lock().unwrap();
        fam.iter().any(|id| running.contains_key(id))
    };
    if busy && input["cancel"] != true {
        return err(format!("\"{title}\" is still running — leave it; close it only if the user wants it cancelled (cancel=true)"));
    }
    let n = archive_family(st, &target, input["reason"].as_str().unwrap_or("closed")).unwrap_or(1);
    ok(format!("closed \"{title}\"{}", if n > 1 { format!(" and {} sub-session(s)", n - 1) } else { String::new() }))
}

/// Archives `id` and everything under it, aborting their runs. Returns how many closed.
pub fn archive_family(st: &AppState, id: &str, reason: &str) -> Option<usize> {
    let family = {
        let sessions = st.sessions.lock().unwrap();
        if !sessions.contains_key(id) {
            return None;
        }
        let mut fam = descendants(&sessions, id);
        fam.insert(0, id.to_string());
        fam
    };
    for sid in &family {
        if let Some(n) = st.running.lock().unwrap().get(sid).cloned() {
            n.notify_one();
        }
        with_session(st, sid, |s| {
            s.info["archived"] = json!(true);
            s.info["time"]["archived"] = json!(now_ms());
            if !s.info["card"].is_object() {
                s.info["card"] = json!({});
            }
            s.info["card"]["status"] = json!("archived");
            s.info["card"]["headline"] = json!(clip(&format!("closed: {reason}"), 160));
        });
    }
    publish(st, "tree.updated", json!({ "sessionID": id, "archived": true }));
    Some(family.len())
}

// ── the [tree] view ──────────────────────────────────────────────────────────

/// What a managing session sees of its world at the start of each of its turns. The door
/// sees its own subtree plus the other sessions active in the last 2 days; a lead its subtree.
pub fn snapshot(st: &AppState, caller: &str) -> String {
    let sessions = st.sessions.lock().unwrap();
    let door = crate::profile_name_of(st, sessions.get(caller).map(|s| &s.info).unwrap_or(&Value::Null)) == "coordinator";
    let kids = children_map(&sessions);
    let mut lines = Vec::new();
    // depth-first under the caller, open sessions only (closed ones collapse to a count)
    fn walk(st: &AppState, sessions: &HashMap<String, Session>, kids: &HashMap<String, Vec<String>>, id: &str, indent: usize, lines: &mut Vec<String>, closed: &mut usize) {
        let mut ks: Vec<&String> = kids.get(id).map(|v| v.iter().collect()).unwrap_or_default();
        ks.sort_by_key(|k| std::cmp::Reverse(sessions.get(*k).map(|s| s.info["time"]["updated"].as_u64().unwrap_or(0)).unwrap_or(0)));
        for k in ks {
            let Some(s) = sessions.get(k) else { continue };
            if is_archived(s) {
                *closed += 1;
                continue;
            }
            if lines.len() >= 40 {
                return;
            }
            lines.push(card_line(st, k, s, indent));
            walk(st, sessions, kids, k, indent + 1, lines, closed);
        }
    }
    let mut closed = 0usize;
    walk(st, &sessions, &kids, caller, 0, &mut lines, &mut closed);
    if door {
        let cutoff = now_ms().saturating_sub(48 * 3_600_000);
        let mine: HashSet<String> = descendants(&sessions, caller).into_iter().collect();
        let mut other: Vec<(&String, &Session)> = sessions
            .iter()
            .filter(|(id, s)| {
                id.as_str() != caller
                    && !mine.contains(*id)
                    && parent_of(s).is_none()
                    && !is_archived(s)
                    && s.info["time"]["updated"].as_u64().unwrap_or(0) >= cutoff
                    && !crate::is_main_title(&title_of(s))
            })
            .collect();
        other.sort_by_key(|(_, s)| std::cmp::Reverse(s.info["time"]["updated"].as_u64().unwrap_or(0)));
        // a session another root started here is that root's person's work, not this user's:
        // listed apart, so this door starts its own work instead of borrowing it
        let (asked, own): (Vec<_>, Vec<_>) = other.into_iter().partition(|(_, s)| s.info["report_to"]["root"].is_string());
        if !own.is_empty() {
            lines.push("other sessions active in the last 2 days (the user's own):".into());
            for (id, s) in own.into_iter().take(10) {
                lines.push(card_line(st, id, s, 1));
            }
        }
        if !asked.is_empty() {
            lines.push("work other roots asked this machine for (theirs — never reuse it for this user):".into());
            for (id, s) in asked.into_iter().take(5) {
                lines.push(card_line(st, id, s, 1));
            }
        }
    }
    drop(sessions);
    let roots = if door { crate::peers::roots_view(st) } else { String::new() };
    let mut out = format!("{roots}[tree] your sessions now:\n");
    if lines.is_empty() {
        out.push_str("(none yet)\n");
    } else {
        out.push_str(&lines.join("\n"));
        out.push('\n');
    }
    if closed > 0 {
        out.push_str(&format!("({closed} closed session(s) hidden; sessions_find with archived=true)\n"));
    }
    out
}

// ── digest + inbox + wake ────────────────────────────────────────────────────

const DIGEST_SYSTEM: &str = "You file a status card for a work session, for the manager above it. \
Reply with ONLY one JSON object, no prose: {\"status\": \"done|working|blocked|failed\", \
\"headline\": \"<=140 chars: what happened this turn, concrete (files, numbers, test results)\", \
\"summary\": \"<=450 chars: where the session stands now — what exists, how it was verified, what is next\", \
\"needs\": \"the exact question for the user if it is blocked on them, else empty\", \
\"relevance\": \"needs_you|worth_knowing|routine\"}. \
status: done = the requested work is finished; working = still in progress (waiting on sub-sessions counts); \
blocked = waiting for a decision or answer; failed = could not do it. \
relevance (for the human user): needs_you = they must decide or act; worth_knowing = a result they asked for \
is ready, or something failed; routine = progress noise. Never claim verification the reply does not show.";

/// Facts for one digest, gathered under the lock.
struct Facts {
    title: String,
    profile: String,
    brief: String,
    prev: String,
    asked: String,
    reply: String,
    tools: Vec<String>,
    running_kids: usize,
    outcome: &'static str,
}

fn gather(st: &AppState, sid: &str, result: &Result<Value, String>) -> Option<Facts> {
    let sessions = st.sessions.lock().unwrap();
    let s = sessions.get(sid)?;
    let running = st.running.lock().unwrap();
    let running_kids = descendants(&sessions, sid)
        .iter()
        .filter(|d| {
            running.contains_key(d.as_str())
                || sessions.get(d.as_str()).is_some_and(|x| !is_archived(x) && x.info["card"]["status"] == "working")
        })
        .count();
    let (reply, tools, outcome) = match result {
        Ok(m) => {
            let tools = m["parts"].as_array().into_iter().flatten().filter(|p| p["type"] == "tool").filter_map(|p| p["tool"].as_str().map(String::from)).collect();
            let outcome = if m["info"]["error"]["name"] == "MessageAbortedError" {
                "aborted"
            } else if !m["info"]["error"].is_null() {
                "failed"
            } else {
                "ok"
            };
            let mut text = message_text(m);
            if let Some(e) = m["info"]["error"]["data"]["message"].as_str() {
                text = format!("error: {e}\n{text}");
            }
            (text, tools, outcome)
        }
        Err(e) => (format!("error: {e}"), Vec::new(), "failed"),
    };
    let asked = s.messages.iter().rev().find(|m| m["info"]["role"] == "user").map(message_text).unwrap_or_default();
    Some(Facts {
        title: title_of(s),
        profile: crate::profile_name_of(st, &s.info),
        brief: s.info["card"]["brief"].as_str().unwrap_or_default().to_string(),
        prev: s.info["card"]["summary"].as_str().unwrap_or_default().to_string(),
        asked,
        reply,
        tools,
        running_kids,
        outcome,
    })
}

fn extract_json(s: &str) -> Option<Value> {
    let (a, b) = (s.find('{')?, s.rfind('}')?);
    (a < b).then(|| serde_json::from_str::<Value>(&s[a..=b]).ok()).flatten()
}

/// What the facts alone say about a finished turn (the digest may refine a clean `done`).
fn fact_status(f: &Facts) -> &'static str {
    match f.outcome {
        "failed" => "failed",
        "aborted" => "aborted",
        _ if f.reply.contains("QUESTION:") => "blocked",
        _ if f.running_kids > 0 => "working",
        _ => "done",
    }
}

/// The card + event for one finished turn. Deterministic facts override the model:
/// a failed run is failed, `QUESTION:` is blocked, running sub-sessions mean working.
async fn digest(st: &AppState, sid: &str, f: &Facts) -> Value {
    let question = f.reply.find("QUESTION:").map(|i| one_line(&f.reply[i + 9..], 300));
    let mut status = fact_status(f).to_string();
    let first = f.reply.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("(no reply)");
    let mut headline = one_line(first, 140);
    let mut summary = one_line(&f.reply, 450);
    let mut needs = question.clone().unwrap_or_default();
    let mut relevance = match status.as_str() {
        "blocked" => "needs_you",
        "working" => "routine",
        _ => "worth_knowing",
    }
    .to_string();
    let user = format!(
        "Session \"{}\" (profile {}).\nIts brief: {}\nPrevious summary: {}\nSub-sessions still running: {}\nThis turn was asked: {}\nTools used this turn: {} ({})\nOutcome: {}\nIts reply:\n{}",
        f.title,
        f.profile,
        clip(&f.brief, 500),
        clip(&f.prev, 450),
        f.running_kids,
        clip(&f.asked, 700),
        f.tools.len(),
        f.tools.iter().take(12).cloned().collect::<Vec<_>>().join(","),
        f.outcome,
        clip(&f.reply, 3500)
    );
    let model = st.config.tree.digest_model.clone().unwrap_or_else(|| st.config.model.clone());
    let got = tokio::time::timeout(std::time::Duration::from_secs(40), crate::upstream_once(st, &model, DIGEST_SYSTEM, &user, 700)).await;
    match got {
        Ok(Ok(text)) => match extract_json(&text) {
            Some(v) => {
                if let Some(h) = v["headline"].as_str().filter(|h| !h.trim().is_empty()) {
                    headline = one_line(h, 140);
                }
                if let Some(s) = v["summary"].as_str().filter(|s| !s.trim().is_empty()) {
                    summary = one_line(s, 450);
                }
                if needs.is_empty() {
                    needs = v["needs"].as_str().map(|n| one_line(n, 300)).unwrap_or_default();
                }
                // the model may refine done/working/blocked for a clean run, never overrule facts
                if f.outcome == "ok" && question.is_none() && f.running_kids == 0 {
                    if let Some(m) = v["status"].as_str().filter(|m| matches!(*m, "done" | "working" | "blocked")) {
                        status = m.into();
                    }
                }
                // ...but a run that ENDED with nothing running under it is not working: it said it
                // would carry on and stopped — stalled (11-13: an AGI session "waiting for inv.py"
                // sat as `working` for 15 min, nobody woke it)
                if status == "working" && f.running_kids == 0 {
                    status = "stalled".into();
                }
                if let Some(r) = v["relevance"].as_str().filter(|r| matches!(*r, "needs_you" | "worth_knowing" | "routine")) {
                    relevance = r.into();
                }
            }
            None => eprintln!("digest {sid}: no JSON in reply; deterministic card"),
        },
        Ok(Err(e)) => eprintln!("digest {sid}: {e}; deterministic card"),
        Err(_) => eprintln!("digest {sid}: timeout; deterministic card"),
    }
    // facts over the model's taste: an outcome (done/failed/aborted) is never noise — the
    // person asked for that work (sim away-back 11-12: two finished builds filed as routine,
    // the door never woke); only in-progress turns may be routine
    if status == "blocked" || !needs.is_empty() {
        relevance = "needs_you".into();
    } else if status == "working" {
        relevance = "routine".into();
    } else if relevance == "routine" {
        relevance = "worth_knowing".into();
    }
    if status != "blocked" && question.is_none() && relevance == "needs_you" && needs.is_empty() {
        relevance = "worth_knowing".into();
    }
    json!({
        "id": new_id("evt"), "at": now_ms(), "from": sid, "title": f.title, "profile": f.profile,
        "status": status, "headline": headline, "summary": summary, "needs": needs, "relevance": relevance,
        "body": clip(&f.reply, 2500), "delivered": false,
    })
}

fn write_card(st: &AppState, sid: &str, ev: &Value) {
    let info = with_session(st, sid, |s| {
        let card = &mut s.info["card"];
        if !card.is_object() {
            *card = json!({});
        }
        for k in ["status", "headline", "summary", "needs"] {
            card[k] = ev[k].clone();
        }
        card["updated"] = json!(now_ms());
        card["runs"] = json!(card["runs"].as_u64().unwrap_or(0) + 1);
        s.info.clone()
    });
    if let Some(info) = info {
        publish(st, "session.updated", json!({ "info": info }));
    }
}

/// Where a finished turn reports.
pub enum Target {
    /// a managing session on this root
    Local(String),
    /// the proxy of this session on the root that asked for it
    Peer { root: String, proxy: String },
}

/// Its managing parent, else the turn's origin when that one manages sessions here, else the
/// root that asked for it (`info.report_to`). The origin beats `report_to` (voice-fixes 11-14):
/// a session another root started can still be handed work by THIS root's door — that turn's
/// answer belongs to the person who asked here, not to the other root's MAIN (the lab's backup
/// request went to the home root's session and its result went home). The asking root's own
/// turns arrive with no origin (`origin=none`), so they keep reporting home.
pub fn report_target(st: &AppState, sid: &str, origin: Option<&str>) -> Option<Target> {
    let sessions = st.sessions.lock().unwrap();
    let manages = |id: &str| sessions.get(id).is_some_and(|s| crate::agent(st, &crate::profile_name_of(st, &s.info)).is_some_and(|p| p.sessions));
    let s = sessions.get(sid)?;
    if let Some(p) = parent_of(s).filter(|p| manages(p)) {
        return Some(Target::Local(p));
    }
    if let Some(o) = origin.filter(|o| manages(o)) {
        return Some(Target::Local(o.into()));
    }
    if let (Some(root), Some(proxy)) = (s.info["report_to"]["root"].as_str(), s.info["report_to"]["session"].as_str()) {
        return Some(Target::Peer { root: root.into(), proxy: proxy.into() });
    }
    None
}

/// A peer root reported a turn of the session behind proxy `proxy`: card the proxy, then
/// deliver to its parent exactly like a local report. `false` = no such proxy here.
pub fn accept_report(st: &AppState, proxy: &str, mut ev: Value) -> bool {
    let (parent, title) = {
        let sessions = st.sessions.lock().unwrap();
        let Some(s) = sessions.get(proxy).filter(|s| s.info["remote"].is_object()) else { return false };
        (parent_of(s), title_of(s))
    };
    ev["from"] = json!(proxy);
    ev["title"] = json!(title);
    ev["delivered"] = json!(false);
    write_card(st, proxy, &ev);
    eprintln!("TREE peer report for {proxy}: {} / {}", ev["status"].as_str().unwrap_or("?"), ev["relevance"].as_str().unwrap_or("?"));
    if let Some((root, _)) = crate::peers::remote_of(st, proxy) {
        if let Some(e) = st.config.peers.seen.lock().unwrap().get_mut(&root) {
            e.0 = crate::now_ms();
        }
    }
    if let Some(p) = parent {
        if !(ev["status"] == "working" && ev["relevance"] == "routine") {
            deliver(st, &p, ev);
        }
    }
    true
}

/// A turn of `sid` ended: digest it, card it, file the event with `parent`, wake per policy.
pub fn on_turn_end(st: &AppState, sid: &str, target: Target, result: Result<Value, String>) {
    // coalesced auto turns share one result: report each finished reply once
    if let Ok(m) = &result {
        let mid = m["info"]["id"].clone();
        let fresh = with_session(st, sid, |s| {
            if s.info["card"]["reported"] == mid {
                return false;
            }
            if !s.info["card"].is_object() {
                s.info["card"] = json!({});
            }
            s.info["card"]["reported"] = mid.clone();
            true
        });
        if fresh != Some(true) {
            return;
        }
    }
    let (st, sid) = (st.clone(), sid.to_string());
    tokio::spawn(async move {
        let Some(f) = gather(&st, &sid, &result) else { return };
        // the card stops saying `working` the moment the run ends; the digest refines it
        with_session(&st, &sid, |s| {
            if s.info["card"].is_object() {
                s.info["card"]["status"] = json!(fact_status(&f));
            }
        });
        let ev = digest(&st, &sid, &f).await;
        write_card(&st, &sid, &ev);
        let parent = match &target {
            Target::Local(p) => p.clone(),
            Target::Peer { root, proxy } => format!("{root}/{proxy}"),
        };
        eprintln!(
            "TREE {} -> {}: {} / {} — {}",
            sid,
            parent,
            ev["status"].as_str().unwrap_or("?"),
            ev["relevance"].as_str().unwrap_or("?"),
            ev["headline"].as_str().unwrap_or_default()
        );
        // a session still waiting on its own sub-sessions keeps its parent quiet
        if ev["status"] == "working" && ev["relevance"] == "routine" {
            publish(&st, "tree.updated", json!({ "sessionID": sid }));
            return;
        }
        match target {
            Target::Local(p) => deliver(&st, &p, ev),
            Target::Peer { root, proxy } => crate::peers::report(&st, &root, &proxy, ev).await,
        }
    });
}

/// What the phone's notification says about a session's last reply (owner 11-17: a concise
/// digest per session, not a dump): that turn's digest — {for, title, status, headline, needs,
/// relevance}. The tree's own card when a manager already got this turn, else the same pass made
/// now; kept per reply, so the push and the in-page notification of one turn cost one pass.
pub async fn notice(st: &AppState, sid: &str) -> Option<Value> {
    let last = {
        let sessions = st.sessions.lock().unwrap();
        match notice_ready(sessions.get(sid)?) {
            Ok(n) => return Some(n),
            Err(m) => m?,
        }
    };
    let f = gather(st, sid, &Ok(last.clone()))?;
    let n = notice_of(&digest(st, sid, &f).await, &last);
    // a cache: not persisted, the session's time untouched (the list orders by it)
    if let Some(s) = st.sessions.lock().unwrap().get_mut(sid) {
        s.info["notice"] = n.clone();
    }
    Some(n)
}

/// The notice already made for the session's last finished reply (`Ok`), else that reply to
/// digest (`Err(None)`: it has none yet). A reply still being written is never digested.
fn notice_ready(s: &Session) -> Result<Value, Option<Value>> {
    let done = |m: &&Value| m["info"]["role"] == "assistant" && m["info"]["time"]["completed"].is_number();
    let Some(m) = s.messages.iter().rev().find(done) else {
        return Err(None);
    };
    let mid = &m["info"]["id"];
    if s.info["notice"]["for"] == *mid {
        return Ok(s.info["notice"].clone());
    }
    // a managed session's card, when the tree digested this very turn (written after the reply)
    let card = &s.info["card"];
    let of_this_turn = card["reported"] == *mid
        && card["headline"].is_string()
        && card["updated"].as_u64().unwrap_or(0) >= m["info"]["time"]["created"].as_u64().unwrap_or(u64::MAX);
    if of_this_turn {
        let mut ev = card.clone();
        ev["title"] = json!(title_of(s));
        return Ok(notice_of(&ev, m));
    }
    Err(Some(m.clone()))
}

fn notice_of(ev: &Value, m: &Value) -> Value {
    json!({
        "for": m["info"]["id"], "title": ev["title"], "status": ev["status"],
        "headline": ev["headline"], "needs": ev["needs"], "relevance": ev["relevance"],
    })
}

/// Files an event in `parent`'s inbox and wakes it per its profile.
pub fn deliver(st: &AppState, parent: &str, ev: Value) {
    let filed = with_session(st, parent, |s| {
        s.inbox.push(ev.clone());
        if s.inbox.len() > INBOX_CAP {
            let drop = s.inbox.len() - INBOX_CAP;
            s.inbox.drain(..drop);
        }
    });
    if filed.is_none() {
        return;
    }
    publish(st, "inbox.updated", json!({ "sessionID": parent, "event": ev }));
    let door = st.sessions.lock().unwrap().get(parent).map(|s| crate::profile_name_of(st, &s.info)).as_deref() == Some("coordinator");
    if door {
        if ev["relevance"] != "routine" {
            schedule_wake(st, parent, st.config.tree.wake_debounce_ms);
        }
    } else {
        schedule_wake(st, parent, 600);
    }
}

/// Undelivered events worth a wake: the door only wakes for what matters to the user.
fn take_events(st: &AppState, parent: &str, door: bool) -> Vec<Value> {
    with_session(st, parent, |s| {
        let mut out = Vec::new();
        for e in s.inbox.iter_mut() {
            if e["delivered"] == true || (door && e["relevance"] == "routine") {
                continue;
            }
            e["delivered"] = json!(true);
            out.push(e.clone());
        }
        out
    })
    .unwrap_or_default()
}

/// One pending wake per session; it collects whatever is undelivered when it fires.
fn schedule_wake(st: &AppState, parent: &str, delay_ms: u64) {
    if !st.wakes.lock().unwrap().insert(parent.to_string()) {
        return;
    }
    let (st, parent) = (st.clone(), parent.to_string());
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        st.wakes.lock().unwrap().remove(&parent);
        wake(&st, &parent);
    });
}

fn wake(st: &AppState, parent: &str) {
    let (door, wakes) = {
        let sessions = st.sessions.lock().unwrap();
        let Some(s) = sessions.get(parent) else { return };
        if is_archived(s) {
            return;
        }
        (crate::profile_name_of(st, &s.info) == "coordinator", s.info["card"]["wakes"].as_u64().unwrap_or(0))
    };
    if !door && wakes >= st.config.tree.max_wakes {
        eprintln!("TREE wake budget spent for {parent} ({wakes}); reports stay in its inbox");
        with_session(st, parent, |s| {
            s.info["card"]["status"] = json!("blocked");
            s.info["card"]["needs"] = json!("wake budget spent — a person should look at this session");
        });
        return;
    }
    let events = take_events(st, parent, door);
    if events.is_empty() {
        return;
    }
    let text = if door { door_wake_text(&events) } else { lead_wake_text(&events) };
    with_session(st, parent, |s| s.info["card"]["wakes"] = json!(wakes + 1));
    let turn = Turn { parts: vec![text_part(&text)], modality: None, auto_turn: true, internal: true, origin: None, completes: None };
    match crate::submit(st, parent, turn) {
        Ok(_) => eprintln!("TREE woke {parent} with {} report(s)", events.len()),
        Err(_) => eprintln!("TREE wake of {parent} failed"),
    }
}

/// How a door wake that carries an outcome ends — no (quiet) offered; the run loop retries a
/// (quiet) answer to it once.
pub const OUTCOME_ASK: &str = "Finished, failed, blocked or stalled work above is what the user is waiting for: tell them now — the result and its evidence, in one to four sentences (a stalled session: first send it what it waits for, or ask it to finish).";

fn door_wake_text(events: &[Value]) -> String {
    let mut t = String::from("[inbox] Reports from your sessions since the user last heard from you:\n");
    for e in events {
        t.push_str(&format!(
            "- \"{}\" ({}): {}{} (id={})\n",
            e["title"].as_str().unwrap_or("?"),
            e["status"].as_str().unwrap_or("?"),
            e["headline"].as_str().unwrap_or_default(),
            e["needs"].as_str().filter(|n| !n.is_empty()).map(|n| format!(" — QUESTION for the user: {n}")).unwrap_or_default(),
            e["from"].as_str().unwrap_or("?"),
        ));
        if let Some(s) = e["summary"].as_str().filter(|s| !s.is_empty()) {
            t.push_str(&format!("  state: {s}\n"));
        }
    }
    // facts override the model: an outcome is what the user waits for, so (quiet) is not offered
    // (11-13: a MAIN whose history held a run of quiet replies kept answering a finished build with it)
    if events.iter().any(|e| matches!(e["status"].as_str(), Some("done" | "failed" | "blocked" | "stalled"))) {
        t.push_str(OUTCOME_ASK);
    } else {
        t.push_str("Tell the user what matters to them now, or reply exactly (quiet).");
    }
    t
}

fn lead_wake_text(events: &[Value]) -> String {
    let mut t = String::from("[inbox] Your sub-sessions reported:\n");
    for e in events {
        t.push_str(&format!(
            "\n### \"{}\" — {} (id={})\n{}\n",
            e["title"].as_str().unwrap_or("?"),
            e["status"].as_str().unwrap_or("?"),
            e["from"].as_str().unwrap_or("?"),
            e["body"].as_str().unwrap_or_default()
        ));
    }
    t.push_str("\nVerify what they claim, send fixes or next steps with session_send, start what is still missing, and when the whole goal is met, give your final report.");
    t
}

/// The door's owner turn takes every undelivered event as frozen `[inbox]` lines.
pub fn owner_inbox_lines(st: &AppState, sid: &str) -> Vec<String> {
    take_events(st, sid, false)
        .iter()
        .map(|e| {
            format!(
                "\"{}\" ({}, {}): {}{}",
                e["title"].as_str().unwrap_or("?"),
                e["status"].as_str().unwrap_or("?"),
                e["relevance"].as_str().unwrap_or("?"),
                e["headline"].as_str().unwrap_or_default(),
                e["needs"].as_str().filter(|n| !n.is_empty()).map(|n| format!(" — asks: {n}")).unwrap_or_default()
            )
        })
        .collect()
}

/// An automated post to the door (watcher landings, lane verdict requests, external async
/// completions): it becomes an inbox event — digested like a turn — never a transcript turn.
pub fn external_report(st: &AppState, door: &str, text: &str) {
    let (st, door, text) = (st.clone(), door.to_string(), text.to_string());
    tokio::spawn(async move {
        let f = Facts {
            title: "automation".into(),
            profile: "external".into(),
            brief: "lanes, loops and watchers outside the tree report here".into(),
            prev: String::new(),
            asked: "(automated report)".into(),
            reply: text.clone(),
            tools: Vec::new(),
            running_kids: 0,
            outcome: "ok",
        };
        let mut ev = digest(&st, &door, &f).await;
        ev["title"] = json!(one_line(text.lines().next().unwrap_or("automation"), 60));
        ev["from"] = json!("external");
        deliver(&st, &door, ev);
    });
}

/// A brain restart killed these runs: their cards say so and their parents hear it.
pub fn recover(st: &AppState, interrupted: Vec<String>) {
    for sid in interrupted {
        if let Some(target) = report_target(st, &sid, None) {
            on_turn_end(st, &sid, target, Err("interrupted by a brain restart — send it again to resume".into()));
        }
    }
}

// ── the owner's terminal sessions (11-15) ────────────────────────────────────────────────────
// Claude Code, Antigravity and opencode conversations on this box are sessions too: the
// coordinator finds them (`term:<kind>:<id>`), reads them, sends to them and starts from them.
// The live helper (cc-live: YGG_HARNESS_HELPER + YGG_HARNESS_HELPER_TOKEN) lists and reads them
// and types into one open in tmux or in the background (both ways: the owner sees it in their
// terminal); one not open anywhere continues HERE (THE session on that conversation, under the
// caller); one open in a plain terminal is the owner's to type in — a copy can go on here
// (session_start from=…). Without a helper (a root without one) the tools are as before.

const TERM_KINDS: [&str; 3] = ["claude", "antigravity", "opencode"];

fn helper() -> Option<(String, String)> {
    let url = std::env::var("YGG_HARNESS_HELPER").ok().filter(|u| !u.trim().is_empty())?;
    let tok = std::env::var("YGG_HARNESS_HELPER_TOKEN").ok().filter(|t| !t.trim().is_empty())?;
    Some((url.trim().trim_end_matches('/').to_string(), tok.trim().to_string()))
}

async fn helper_call(st: &AppState, post: Option<Value>, path: &str) -> Result<Value, String> {
    let (url, tok) = helper().ok_or("the owner's terminal sessions are not visible on this root")?;
    let req = match post {
        Some(b) => st.http.post(format!("{url}{path}")).json(&b),
        None => st.http.get(format!("{url}{path}")),
    };
    let r = req.header("x-cc-live-token", tok).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|e| format!("the live helper did not answer: {e}"))?;
    let code = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !code.is_success() {
        return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("the live helper said {code}")));
    }
    Ok(v)
}

/// `term:<kind>:<id>` → (kind, id)
fn term_id(s: &str) -> Option<(&str, &str)> {
    let (k, id) = s.trim().strip_prefix("term:")?.split_once(':')?;
    (TERM_KINDS.contains(&k) && !id.is_empty()).then_some((k, id))
}

fn term_label(kind: &str) -> &'static str {
    match kind {
        "claude" => "Claude Code",
        "antigravity" => "Antigravity",
        _ => "opencode",
    }
}

fn term_live(row: &Value) -> &'static str {
    match row["live"].as_str() {
        Some("tmux") => "open in the owner's terminal (tmux): you can type into it",
        Some("bg") if row["canType"] == true => "running in the background: you can type into it",
        Some("here") => "running a turn here right now",
        Some(_) => "open in the owner's terminal: only they can type there",
        None => "not open anywhere: it continues here when you send to it",
    }
}

fn home(p: &str) -> String {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() && p.starts_with(&h) => format!("~{}", &p[h.len()..]),
        _ => p.to_string(),
    }
}

async fn term_rows(st: &AppState) -> Result<Vec<Value>, String> {
    helper_call(st, None, "/harness").await.map(|v| v["sessions"].as_array().cloned().unwrap_or_default())
}

async fn term_row(st: &AppState, kind: &str, id: &str) -> Result<Value, String> {
    term_rows(st)
        .await?
        .into_iter()
        .find(|r| r["kind"] == kind && r["id"] == id)
        .ok_or_else(|| format!("no terminal session term:{kind}:{id} on this box — sessions_find lists them"))
}

fn term_line(r: &Value) -> String {
    let kind = r["kind"].as_str().unwrap_or_default();
    format!(
        "- \"{}\" [terminal · {} in {}, {}, {} ago] (id=term:{kind}:{})",
        one_line(r["title"].as_str().unwrap_or_default(), 100),
        term_label(kind),
        home(r["cwd"].as_str().unwrap_or_default()),
        term_live(r),
        ago(r["modified"].as_u64().unwrap_or(0)),
        r["id"].as_str().unwrap_or_default()
    )
}

/// The conversation itself, newest last (what the owner and the harness said, its tool calls).
async fn term_transcript(st: &AppState, kind: &str, id: &str) -> String {
    let Ok(v) = helper_call(st, None, &format!("/h/{kind}/{id}/history?limit=80")).await else {
        return "(its transcript could not be read)".into();
    };
    let items = v["items"].as_array().cloned().unwrap_or_default();
    let last_reply = items.iter().rposition(|i| i["k"] == "assistant");
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .filter_map(|(n, i)| {
            let text = i["text"].as_str().unwrap_or_default();
            match i["k"].as_str()? {
                "user" => Some(format!("OWNER: {}", one_line(text, 400))),
                "assistant" if Some(n) == last_reply => Some(format!("{}: {}", term_label(kind), clip(text, 3000))),
                "assistant" => Some(format!("{}: {}", term_label(kind), one_line(text, 300))),
                "tool" => Some(format!("  · {}{}", one_line(i["title"].as_str().unwrap_or_default(), 120), if i["result"]["error"] == true { " (failed)" } else { "" })),
                _ => None,
            }
        })
        .collect();
    let keep = lines.len().saturating_sub(40);
    lines[keep..].join("\n")
}

async fn run_terminal(st: &AppState, caller: &str, name: &str, input: &Value) -> Option<Out> {
    helper()?;
    match name {
        "sessions_find" => {
            let local = find(st, caller, input);
            let rows = term_rows(st).await.ok()?;
            let q = input["query"].as_str().unwrap_or_default().to_lowercase();
            let any = ["terminal", "cmd", "omarchy", "tmux"].iter().any(|w| q.contains(w));
            let qt = tokens(&q);
            let mut hits: Vec<(usize, &Value)> = rows
                .iter()
                .filter_map(|r| {
                    let kind = r["kind"].as_str().unwrap_or_default();
                    let hay = tokens(&format!("{} {}", r["title"].as_str().unwrap_or_default(), r["cwd"].as_str().unwrap_or_default()));
                    let words = qt.iter().filter(|t| hay.contains(t)).count();
                    let named = (kind == "claude" && q.contains("claude"))
                        || (kind == "antigravity" && (q.contains("agy") || q.contains("antigravity")))
                        || (kind == "opencode" && q.contains("opencode"));
                    let open = !r["live"].is_null();
                    let sc = words * 2 + usize::from(named) * 2 + usize::from(open) * (if any { 3 } else { 1 });
                    (words > 0 || named || (any && open)).then_some((sc, r))
                })
                .collect();
            hits.sort_by(|a, b| b.0.cmp(&a.0));
            hits.truncate(8);
            if hits.is_empty() {
                return Some(local);
            }
            let lines: Vec<String> = hits.iter().map(|(_, r)| term_line(r)).collect();
            let head = if local.ok && !local.output.starts_with("no session matches") { format!("{}\n", local.output) } else { String::new() };
            Some(ok(format!("{head}the owner's terminal sessions on this box:\n{}", lines.join("\n"))))
        }
        "session_read" => {
            let key = input["id"].as_str().unwrap_or_default();
            if let Some((kind, id)) = term_id(key) {
                let row = match term_row(st, kind, id).await {
                    Ok(r) => r,
                    Err(e) => return Some(err(e)),
                };
                return Some(ok(format!(
                    "\"{}\" (id=term:{kind}:{id}) — the owner's {} session in {}: {}\n{}\n",
                    one_line(row["title"].as_str().unwrap_or_default(), 100),
                    term_label(kind),
                    home(row["cwd"].as_str().unwrap_or_default()),
                    term_live(&row),
                    term_transcript(st, kind, id).await
                )));
            }
            // a session here on a terminal's conversation: its card, then the conversation itself
            let (kind, id) = attached_conv(st, key)?;
            let local = read(st, caller, input);
            if !local.ok {
                return Some(local);
            }
            Some(ok(format!("{}the conversation itself ({}, the terminal's turns too), newest last:\n{}\n", local.output, term_label(&kind), term_transcript(st, &kind, &id).await)))
        }
        "session_send" => {
            let key = input["id"].as_str().unwrap_or_default();
            let message = input["message"].as_str().unwrap_or_default();
            if message.trim().is_empty() {
                return None;
            }
            if let Some((kind, id)) = term_id(key) {
                return Some(term_send(st, caller, kind, id, message).await);
            }
            // a session here whose conversation is open in the terminal right now: typed in there
            let (kind, id) = attached_conv(st, key)?;
            let row = term_row(st, &kind, &id).await.ok()?;
            row["live"].as_str().filter(|l| *l != "here")?;
            Some(term_send(st, caller, &kind, &id, message).await)
        }
        "session_start" => {
            let from = input["from"].as_str().map(str::trim).filter(|f| !f.is_empty())?;
            Some(start_from(st, caller, input, from).await)
        }
        _ => None,
    }
}

/// (kind, conversation id) of a session here that holds a terminal's conversation.
fn attached_conv(st: &AppState, key: &str) -> Option<(String, String)> {
    let sessions = st.sessions.lock().unwrap();
    let h = &sessions.get(&resolve(&sessions, key)?)?.info["harness"];
    let kind = crate::harness::Kind::parse(h["kind"].as_str()?)?.name();
    (h["attached"] == true && TERM_KINDS.contains(&kind))
        .then(|| (kind.to_string(), h["id"].as_str().unwrap_or_default().to_string()))
        .filter(|(_, id)| !id.is_empty())
}

async fn term_send(st: &AppState, caller: &str, kind: &str, id: &str, message: &str) -> Out {
    let row = match term_row(st, kind, id).await {
        Ok(r) => r,
        Err(e) => return err(e),
    };
    let title = one_line(row["title"].as_str().unwrap_or_default(), 80);
    if row["canType"] == true {
        return match helper_call(st, Some(json!({ "text": message })), &format!("/h/{kind}/{id}/input")).await {
            Ok(_) => ok(format!(
                "TYPED into the owner's {} session \"{title}\" (open in their terminal): it answers there and the owner sees it live. It does not report back to you — read its answer later with session_read id=term:{kind}:{id}.",
                term_label(kind)
            )),
            Err(e) => err(e),
        };
    }
    match row["live"].as_str() {
        Some("here") => return err(format!("\"{title}\" is running a turn here right now — send when it is done")),
        Some(_) => {
            return err(format!(
                "\"{title}\" is open in the owner's terminal: only they can type there (it is not in tmux). To go on with it here, start a copy: session_start with from=term:{kind}:{id} — its whole context, the terminal's conversation untouched."
            ));
        }
        None => {}
    }
    // not open anywhere: THE session here on that conversation (under you), then a normal send
    let opts = crate::AttachOpts { parent: Some(caller.to_string()), title: Some(title.clone()), ..Default::default() };
    let info = match crate::attach_conversation(st, kind, id, row["cwd"].as_str().unwrap_or_default(), opts) {
        Ok(i) => i,
        Err(e) => return err(e),
    };
    let sid = info["id"].as_str().unwrap_or_default().to_string();
    with_session(st, &sid, |s| {
        if !s.info["card"].is_object() {
            s.info["card"] = json!({ "topic": title, "brief": format!("the owner's {} conversation from their terminal", term_label(kind)),
                "status": "idle", "by": caller, "created": now_ms(), "updated": now_ms() });
        }
    });
    send(st, caller, &json!({ "id": sid, "message": message }))
}

/// session_start from=…: a copy of a terminal's conversation (or of a session here on one), its
/// whole context, under the caller; the brief is its first message.
async fn start_from(st: &AppState, caller: &str, input: &Value, from: &str) -> Out {
    let Some(brief) = input["brief"].as_str().filter(|b| !b.trim().is_empty()) else { return err("brief required".into()) };
    let (kind, id, cwd, title) = if let Some((kind, id)) = term_id(from) {
        match term_row(st, kind, id).await {
            Ok(r) => (kind.to_string(), id.to_string(), r["cwd"].as_str().unwrap_or_default().to_string(), r["title"].as_str().unwrap_or_default().to_string()),
            Err(e) => return err(e),
        }
    } else {
        let Some((kind, id)) = attached_conv(st, from) else {
            return err(format!("{from:?} is neither a terminal session (term:…) nor a session here on Claude Code, opencode or Antigravity"));
        };
        let sessions = st.sessions.lock().unwrap();
        let s = resolve(&sessions, from).and_then(|t| sessions.get(&t).map(|s| (s.info["cwd"].as_str().unwrap_or_default().to_string(), title_of(s))));
        let (cwd, title) = s.unwrap_or_default();
        (kind, id, cwd, title)
    };
    let title = input["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from).unwrap_or(title);
    let opts = crate::AttachOpts {
        parent: Some(caller.to_string()),
        title: Some(title.clone()),
        model: input["model"].as_str().filter(|m| !m.is_empty()).map(String::from),
        fork: true,
        ..Default::default()
    };
    let info = match crate::attach_conversation(st, &kind, &id, &cwd, opts) {
        Ok(i) => i,
        Err(e) => return err(e),
    };
    let sid = info["id"].as_str().unwrap_or_default().to_string();
    let t = info["title"].as_str().unwrap_or_default().to_string();
    with_session(st, &sid, |s| {
        s.info["card"] = json!({ "topic": t, "brief": clip(brief, 600), "status": "working", "by": caller, "created": now_ms(), "updated": now_ms() });
    });
    let turn = Turn { parts: vec![text_part(brief)], modality: None, auto_turn: false, internal: false, origin: Some(caller.to_string()), completes: None };
    if let Err(e) = crate::submit(st, &sid, turn) {
        return err(format!("created {sid} but could not post the brief ({:?})", e.status()));
    }
    publish(st, "tree.updated", json!({ "sessionID": sid, "parentID": caller }));
    ok(format!(
        "STARTED, NOT DONE YET: id={sid} \"{t}\" — a copy of the owner's {} conversation (its whole context; theirs is untouched) — is on it and reports back when finished. Tell the user it is on its way (→ {t}); never say it is done.",
        term_label(&kind)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outcome_wake_offers_no_quiet() {
        let done = json!({"title": "hi", "status": "done", "headline": "built, 1 passed", "from": "ses_1"});
        let moving = json!({"title": "hi", "status": "working", "headline": "half way", "from": "ses_1"});
        assert!(!door_wake_text(&[done.clone()]).contains("(quiet)"));
        assert!(door_wake_text(&[moving.clone()]).contains("(quiet)"));
        assert!(!door_wake_text(&[moving, done]).contains("(quiet)"), "one outcome is enough");
        let stalled = json!({"title": "readme", "status": "stalled", "headline": "waiting for inv.py", "from": "ses_2"});
        assert!(!door_wake_text(&[stalled]).contains("(quiet)"), "a stalled session is an outcome");
    }

    fn sess(id: &str, title: &str, parent: Option<&str>, card: Value) -> (String, Session) {
        let mut info = json!({ "id": id, "title": title, "time": { "created": now_ms(), "updated": now_ms() }, "card": card });
        if let Some(p) = parent {
            info["parentID"] = json!(p);
        }
        (id.to_string(), Session { info, messages: Vec::new(), todo: Vec::new(), inbox: Vec::new() })
    }

    #[test]
    fn geometry() {
        let m: HashMap<String, Session> = [
            sess("a", "[MAIN]", None, json!({})),
            sess("b", "proj", Some("a"), json!({})),
            sess("c", "part", Some("b"), json!({})),
            sess("d", "sub", Some("c"), json!({})),
            sess("e", "other", None, json!({})),
        ]
        .into_iter()
        .collect();
        assert_eq!(depth(&m, "a"), 0);
        assert_eq!(depth(&m, "d"), 3);
        let mut ds = descendants(&m, "a");
        ds.sort();
        assert_eq!(ds, vec!["b", "c", "d"]);
        assert!(descendants(&m, "e").is_empty());
    }

    #[test]
    fn cycle_safe() {
        let m: HashMap<String, Session> = [sess("x", "x", Some("y"), json!({})), sess("y", "y", Some("x"), json!({}))].into_iter().collect();
        assert!(depth(&m, "x") <= 2);
        assert_eq!(descendants(&m, "x").len(), 2);
    }

    #[test]
    fn ranking_prefers_topic_matches() {
        let (_, timer) = sess("t", "pomodoro timer cli", Some("a"), json!({ "topic": "pomodoro timer", "summary": "python cli with tests" }));
        let (_, site) = sess("s", "recipe site", Some("a"), json!({ "topic": "recipe website", "summary": "static html pages" }));
        assert!(score("the timer thing, make it beep", &timer) > score("the timer thing, make it beep", &site));
        assert!(score("recipes page colors", &site) > 0.5);
        assert_eq!(score("zzz qqq", &site), 0.0);
        assert!(tokens("The CLI and the API").contains(&"cli".to_string()));
    }

    #[test]
    fn unique_titles_by_slug() {
        let m: HashMap<String, Session> = [sess("a", "[MAIN]", None, json!({})), sess("b", "Recipe Site", None, json!({}))].into_iter().collect();
        assert_eq!(unique_title(&m, "recipe site"), "recipe site 2");
        assert_eq!(unique_title(&m, "[MAIN]"), "work");
        assert_eq!(unique_title(&m, "timer"), "timer");
    }

    #[test]
    fn a_notice_is_made_once_per_reply() {
        let reply = |id: &str, at: u64| json!({"info": {"id": id, "role": "assistant", "time": {"created": at, "completed": at + 5}}, "parts": [{"type": "text", "text": "## Status\n- done"}]});
        let (_, mut s) = sess("n", "notes", None, json!({}));
        assert_eq!(notice_ready(&s), Err(None), "no reply yet: nothing to say");
        s.messages.push(reply("msg_1", 100));
        assert_eq!(notice_ready(&s), Err(Some(s.messages[0].clone())), "a new reply is digested");
        s.info["notice"] = json!({"for": "msg_1", "headline": "notes filed"});
        assert_eq!(notice_ready(&s).unwrap()["headline"], "notes filed", "the same reply: the notice made for it");
        let mut writing = reply("msg_2", 200);
        writing["info"]["time"]["completed"] = Value::Null;
        s.messages.push(writing);
        assert_eq!(notice_ready(&s).unwrap()["for"], "msg_1", "a reply still being written: the last finished one");
        s.messages[1]["info"]["time"]["completed"] = json!(205);
        assert!(notice_ready(&s).is_err(), "a newer reply: a new notice");
        // a managed session: the tree's card of THIS turn is the notice; one from before it is not
        s.info["card"] = json!({"reported": "msg_2", "headline": "built, 3 passed", "status": "done", "needs": "", "updated": 150});
        assert!(notice_ready(&s).is_err(), "the card was written before this reply");
        s.info["card"]["updated"] = json!(250);
        let n = notice_ready(&s).unwrap();
        assert_eq!((n["for"].as_str(), n["headline"].as_str(), n["title"].as_str()), (Some("msg_2"), Some("built, 3 passed"), Some("notes")));
    }

    #[test]
    fn json_extraction() {
        assert_eq!(extract_json("sure: {\"status\":\"done\"} ok").unwrap()["status"], "done");
        assert!(extract_json("nothing").is_none());
    }
}
