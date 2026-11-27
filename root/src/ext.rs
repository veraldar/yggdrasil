//! Extensions (root-coord, 11-13): capabilities that live OUTSIDE the core — their own process, any
//! language, improved and added independently (the librarian is the first). The core only knows
//! this interface. An extension is an HTTP service listed in `YGG_EXTENSIONS` (`name=url,…`):
//!
//! - `GET {url}/manifest` → `{"name", "description", "prompt"?, "tools": [{"name", "description",
//!   "parameters": <JSON schema>, "scope": "self" | "world"}]}` — read again every 60 s, so an
//!   extension started (or upgraded) later shows up without restarting the root. `prompt` (one or
//!   two sentences: when agents should reach for it) joins the shared prompt while it is up.
//! - `POST {url}/call/{tool}` `{"input": {…}, "session": "<caller id>", "root": "<root name>"}` →
//!   `{"output": "text"}` or `{"error": "text"}`.
//! - Agents see the tools as `<extension>_<tool>` (`librarian_search`). A `self` tool only reads
//!   or writes the extension's own data: every agent may use it. A `world` tool changes things
//!   outside (files, devices, services): only agents whose rules allow it (a blanket `*`, or the
//!   tool's name), like any other tool.
//! - An extension reads the root through the root's normal HTTP API. `YGG_EXT_TOKEN`, when set,
//!   rides every call as `x-ygg-ext`.
//!
//! Every computer (B7b, 11-19): a `self` tool whose manifest declares a `roots` parameter
//! (`librarian_search`) called with `roots: "all"` runs here AND on every peer root at once
//! (`POST /ext/{name}/call` there, 3 s each); each hit is labelled with its computer
//! (`[this computer]`, `[lab]`), a peer that fails is listed `lab: unreachable`. That route
//! answers peers only (the peer token), runs `self` tools only, never fans out again; a root
//! with no librarian still answers `librarian` `search` with a plain search of its own sessions.

use std::{collections::HashMap, future::Future, sync::Mutex, time::Duration};

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{AppState, Session, peers::Peers, profiles::Profile, tools::ToolResult};

/// How long a peer root gets to answer a fanned-out call.
const PEER_TIMEOUT_S: u64 = 3;

pub struct Extensions {
    pub list: Vec<(String, String)>,
    token: Option<String>,
    /// name → manifest, for the extensions that answered their last poll
    pub manifests: Mutex<HashMap<String, Value>>,
}

/// One extension tool as an agent sees it.
struct Found {
    ext: String,
    tool: String,
    world: bool,
    /// its parameters declare `roots`: `roots: "all"` asks every root (see `fan_out`)
    roots: bool,
}

impl Extensions {
    pub fn load() -> Extensions {
        let list = std::env::var("YGG_EXTENSIONS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|p| p.split_once('=').map(|(n, u)| (n.trim().to_string(), u.trim().trim_end_matches('/').to_string())))
            .filter(|(n, u)| !n.is_empty() && !u.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        Extensions { list, token: std::env::var("YGG_EXT_TOKEN").ok().filter(|t| !t.is_empty()), manifests: Mutex::default() }
    }

    fn find(&self, name: &str) -> Option<Found> {
        let m = self.manifests.lock().unwrap();
        m.iter().find_map(|(ext, man)| {
            let tool = name.strip_prefix(ext.as_str())?.strip_prefix('_')?;
            let t = man["tools"].as_array()?.iter().find(|t| t["name"] == tool)?;
            Some(Found { ext: ext.clone(), tool: tool.to_string(), world: t["scope"] != "self", roots: t["parameters"]["properties"]["roots"].is_object() })
        })
    }

    pub fn owns(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    /// The scope of tool `tool` of extension `ext` while it is up (`self`, `world`, `internal`;
    /// none written = `world`); None when it is down, not listed, or has no such tool.
    fn scope(&self, ext: &str, tool: &str) -> Option<String> {
        let m = self.manifests.lock().unwrap();
        let t = m.get(ext)?["tools"].as_array()?.iter().find(|t| t["name"] == tool)?.clone();
        Some(t["scope"].as_str().unwrap_or("world").to_string())
    }

    /// May `prof` use the extension tool `name`? (`self` tools: everyone; `world`: its rules.)
    pub fn allows(&self, prof: &Profile, name: &str) -> bool {
        self.find(name).is_some_and(|f| !f.world || prof.check(name, &json!({})).is_ok())
    }

    /// The function schemas of every extension tool `prof` may use.
    pub fn schemas(&self, prof: &Profile) -> Vec<Value> {
        let tools: Vec<(String, Value)> = {
            let m = self.manifests.lock().unwrap();
            m.iter()
                .flat_map(|(ext, man)| man["tools"].as_array().cloned().unwrap_or_default().into_iter().map(move |t| (ext.clone(), t)))
                .collect()
        };
        tools
            .into_iter()
            // `internal` tools are for the brain itself (the context viewer's memory part, …),
            // never offered to an agent
            .filter(|(_, t)| t["scope"] != "internal")
            .filter_map(|(ext, t)| {
                let name = format!("{ext}_{}", t["name"].as_str()?);
                self.allows(prof, &name).then(|| {
                    let params = if t["parameters"].is_object() { t["parameters"].clone() } else { json!({ "type": "object", "properties": {} }) };
                    json!({ "type": "function", "function": {
                        "name": name,
                        "description": format!("[{ext} extension] {}", t["description"].as_str().unwrap_or_default()),
                        "parameters": params,
                    }})
                })
            })
            .collect()
    }

    /// An internal tool the brain itself calls (`<ext>_<tool>` naming, no profile check, no
    /// schemas exposure): returns the output text.
    pub async fn call_internal(&self, st: &AppState, ext: &str, tool: &str, input: &Value) -> Result<String, String> {
        let Some((_, url)) = self.list.iter().find(|(n, _)| n == ext) else {
            return Err(format!("extension {ext} is not configured"));
        };
        let body = json!({ "input": input, "session": "", "root": st.config.peers.me, "internal": true });
        let reply = self
            .post(st, format!("{url}/call/{tool}"), body, 30)
            .send()
            .await
            .map_err(|e| format!("extension {ext} unreachable: {e}"))?
            .json::<Value>()
            .await
            .map_err(|e| format!("unreadable answer: {e}"))?;
        match reply["error"].as_str() {
            Some(e) => Err(e.to_string()),
            None => Ok(reply["output"].as_str().unwrap_or_default().to_string()),
        }
    }

    /// What the extensions that are up ask every agent to know (their manifest `prompt`), as one
    /// block for the shared prompt — `None` when there is nothing to say.
    pub fn prompt(&self) -> Option<String> {
        let m = self.manifests.lock().unwrap();
        let mut lines: Vec<String> = m
            .iter()
            .filter_map(|(n, man)| man["prompt"].as_str().filter(|p| !p.trim().is_empty()).map(|p| format!("- {n}: {}", p.trim())))
            .collect();
        lines.sort();
        (!lines.is_empty()).then(|| format!("[extensions]\n{}", lines.join("\n")))
    }

    /// `GET /extensions`: every configured extension, whether it answers, and its tools.
    pub fn describe(&self) -> Value {
        let m = self.manifests.lock().unwrap();
        json!(self.list.iter().map(|(name, url)| {
            let man = m.get(name);
            json!({
                "name": name, "url": url, "up": man.is_some(),
                "description": man.and_then(|x| x["description"].as_str()).unwrap_or_default(),
                "tools": man.and_then(|x| x["tools"].as_array()).into_iter().flatten()
                    .map(|t| json!({ "name": t["name"], "scope": if t["scope"] == "self" { "self" } else { "world" }, "description": t["description"] }))
                    .collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>())
    }

    fn post(&self, st: &AppState, url: String, body: Value, timeout: u64) -> reqwest::RequestBuilder {
        let req = st.http.post(url).timeout(Duration::from_secs(timeout)).json(&body);
        match &self.token {
            Some(t) => req.header("x-ygg-ext", t),
            None => req,
        }
    }
}

/// Run an extension tool for session `caller` — on every root at once when it takes `roots` and
/// the call says `roots: "all"`.
pub async fn call(st: &AppState, caller: &str, name: &str, input: &Value) -> ToolResult {
    let Some(f) = st.config.ext.find(name) else {
        return ToolResult { ok: false, title: name.to_string(), output: format!("no extension tool {name}"), metadata: json!({}) };
    };
    if !(f.roots && !f.world && input["roots"] == "all") {
        return call_local(st, caller, name, &f, input).await;
    }
    let mut input = input.clone();
    if let Some(o) = input.as_object_mut() {
        o.remove("roots");
    }
    let peers = st.config.peers.names();
    let body = json!({ "tool": f.tool, "input": input });
    let path = format!("/ext/{}/call", f.ext);
    let ask = |peer: String| {
        let (body, path) = (body.clone(), path.clone());
        async move {
            let v = crate::peers::call(st, &peer, "POST", &path, Some(body), PEER_TIMEOUT_S).await?;
            match (v["output"].as_str(), v["error"].as_str()) {
                (Some(o), _) => Ok(o.to_string()),
                (None, Some(e)) => Err(e.to_string()),
                (None, None) => Err(format!("no output in {v}")),
            }
        }
    };
    let mut res = fan_out(call_local(st, caller, name, &f, &input), peers.clone(), Duration::from_secs(PEER_TIMEOUT_S), ask).await;
    res.title = name.to_string();
    res.metadata = json!({ "extension": f.ext, "roots": peers });
    res
}

/// Runs the local call and asks every peer at once (each within `timeout`); one text, every
/// line labelled with its computer: `- [this computer] …`, `- [lab] …`; a peer that fails or
/// does not answer in time: `- lab: unreachable`. Ok when any computer answered.
async fn fan_out<L, F, Fut>(local: L, peers: Vec<String>, timeout: Duration, ask: F) -> ToolResult
where
    L: Future<Output = ToolResult>,
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let asks = peers.iter().map(|p| tokio::time::timeout(timeout, ask(p.clone())));
    let (mine, theirs) = futures::future::join(local, futures::future::join_all(asks)).await;
    let mut ok = mine.ok;
    let mut out = vec![label("this computer", &mine.output)];
    for (peer, r) in peers.iter().zip(theirs) {
        match r {
            Ok(Ok(text)) => {
                ok = true;
                out.push(label(peer, &text));
            }
            Ok(Err(e)) => {
                eprintln!("ext fan-out: {peer}: {e}");
                out.push(format!("- {peer}: unreachable"));
            }
            Err(_) => {
                eprintln!("ext fan-out: {peer}: no answer in {} s", timeout.as_secs_f32());
                out.push(format!("- {peer}: unreachable"));
            }
        }
    }
    ToolResult { ok, title: String::new(), output: out.join("\n"), metadata: json!({}) }
}

/// Every non-empty line of one computer's answer as `- [<root>] …` (a hit's own `- ` kept once).
fn label(root: &str, text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .map(|l| format!("- [{root}] {}", l.strip_prefix("- ").unwrap_or(l)))
        .collect();
    if lines.is_empty() { format!("- [{root}] (no answer)") } else { lines.join("\n") }
}

/// The plain call: this root's own extension.
async fn call_local(st: &AppState, caller: &str, name: &str, f: &Found, input: &Value) -> ToolResult {
    let fail = |output: String| ToolResult { ok: false, title: name.to_string(), output, metadata: json!({}) };
    let x = &st.config.ext;
    let Some((_, url)) = x.list.iter().find(|(n, _)| *n == f.ext) else { return fail(format!("extension {} is not configured", f.ext)) };
    let body = json!({ "input": input, "session": caller, "root": st.config.peers.me });
    let reply = match x.post(st, format!("{url}/call/{}", f.tool), body, 120).send().await {
        Ok(r) => r.json::<Value>().await.unwrap_or_else(|e| json!({ "error": format!("unreadable answer: {e}") })),
        Err(e) => return fail(format!("extension {} unreachable: {e}", f.ext)),
    };
    match reply["error"].as_str() {
        Some(e) => fail(e.to_string()),
        None => ToolResult { ok: true, title: name.to_string(), output: reply["output"].as_str().unwrap_or_default().to_string(), metadata: json!({ "extension": f.ext }) },
    }
}

/// A call from a peer root: a token is configured here and the request carries it.
fn peer_ok(p: &Peers, headers: &HeaderMap) -> bool {
    p.token.is_some() && headers.contains_key("x-ygg-peer") && p.authorized(headers)
}

/// `POST /ext/{name}/call` `{tool, input}` → `{output}` | `{error}` — a peer root (a hub fanning
/// out a `roots: "all"` call) runs one of this root's extension tools, as the brain itself.
/// Peer token only (401); `self` tools only (403); never fans out again. A root with no
/// librarian up still answers `librarian` `search`: a plain search of its own sessions.
pub async fn peer_route(State(st): State<AppState>, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let answer = |code: StatusCode, v: Value| (code, Json(v)).into_response();
    if !peer_ok(&st.config.peers, &headers) {
        return answer(StatusCode::UNAUTHORIZED, json!({ "error": "peer token" }));
    }
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(tool) = body["tool"].as_str().filter(|t| !t.is_empty()) else {
        return answer(StatusCode::BAD_REQUEST, json!({ "error": "tool required" }));
    };
    let mut input = if body["input"].is_object() { body["input"].clone() } else { json!({}) };
    input.as_object_mut().map(|o| o.remove("roots"));
    let fallback = name == "librarian" && tool == "search";
    let x = &st.config.ext;
    match x.scope(&name, tool).as_deref() {
        Some("self") => match x.call_internal(&st, &name, tool, &input).await {
            Ok(output) => answer(StatusCode::OK, json!({ "output": output })),
            Err(e) if fallback => {
                eprintln!("ext: peer search: the librarian failed ({e}) — searching the sessions");
                answer(StatusCode::OK, json!({ "output": search_sessions(&st, &input) }))
            }
            Err(e) => answer(StatusCode::OK, json!({ "error": e })),
        },
        Some(_) => answer(StatusCode::FORBIDDEN, json!({ "error": format!("{name}_{tool} is not a self tool: peers may not run it") })),
        None if fallback => answer(StatusCode::OK, json!({ "output": search_sessions(&st, &input) })),
        None => answer(StatusCode::NOT_FOUND, json!({ "error": format!("no extension tool {name}_{tool} here") })),
    }
}

/// The search of a root with no librarian: `input.query`, `input.limit` over its own sessions.
fn search_sessions(st: &AppState, input: &Value) -> String {
    let limit = input["limit"].as_u64().unwrap_or(8).clamp(1, 25) as usize;
    let sessions = st.sessions.lock().unwrap();
    find_in_sessions(sessions.values(), input["query"].as_str().unwrap_or_default(), limit)
}

/// Every session (never a test one) whose title + one message's text hold all the words of
/// `query` (case-insensitive): the newest such message per session, newest sessions first, at
/// most `limit`, each `- "<title>" (id=…): …snippet…` (≤ 200 characters around the match).
fn find_in_sessions<'a>(sessions: impl Iterator<Item = &'a Session>, query: &str, limit: usize) -> String {
    let words: Vec<String> = query.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    if words.is_empty() {
        return "say what to look for".into();
    }
    let has_all = |hay: &str| {
        let hay = hay.to_lowercase();
        words.iter().all(|w| hay.contains(w.as_str()))
    };
    let mut hits: Vec<(u64, String)> = vec![];
    for s in sessions.filter(|s| !crate::tree::is_test(s)) {
        let title = s.info["title"].as_str().unwrap_or("untitled");
        let id = s.info["id"].as_str().unwrap_or_default();
        let said = s.messages.iter().rev().find_map(|m| {
            let text = m["parts"].as_array()?.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n");
            (!text.trim().is_empty() && has_all(&format!("{title}\n{text}"))).then(|| (m["info"]["time"]["created"].as_u64().unwrap_or(0), text))
        });
        let hit = said.or_else(|| has_all(title).then(|| (s.info["time"]["updated"].as_u64().unwrap_or(0), title.to_string())));
        if let Some((at, text)) = hit {
            hits.push((at, format!("- \"{title}\" (id={id}): {}", snippet(&text, &words, 200))));
        }
    }
    if hits.is_empty() {
        return format!("nothing found for {query:?}");
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().take(limit).map(|(_, h)| h).collect::<Vec<_>>().join("\n")
}

/// At most `max` characters of `text` (whitespace folded) around the first word of `words` it
/// holds, `…` where cut.
fn snippet(text: &str, words: &[String], max: usize) -> String {
    let chars: Vec<char> = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect();
    if chars.len() <= max {
        return chars.into_iter().collect();
    }
    // one lowercase char per char, so an index here is an index in `chars`
    let low: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let at = words
        .iter()
        .find_map(|w| {
            let w: Vec<char> = w.chars().collect();
            low.windows(w.len()).position(|x| x == w.as_slice())
        })
        .unwrap_or(0);
    let room = max - 2; // the two `…`
    let start = at.saturating_sub(room / 3).min(chars.len() - room);
    let end = start + room;
    format!("{}{}{}", if start > 0 { "…" } else { "" }, chars[start..end].iter().collect::<String>(), if end < chars.len() { "…" } else { "" })
}

/// Read every manifest: every 3 s until all answered once (an extension starting next to the root
/// is there by its first turns), then every 60 s.
pub fn spawn_watch(st: &AppState) {
    if st.config.ext.list.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            for (name, url) in st.config.ext.list.clone() {
                let mut req = st.http.get(format!("{url}/manifest")).timeout(Duration::from_secs(5));
                if let Some(t) = &st.config.ext.token {
                    req = req.header("x-ygg-ext", t);
                }
                let man = match req.send().await {
                    Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().filter(|m| m["tools"].is_array()),
                    _ => None,
                };
                let mut m = st.config.ext.manifests.lock().unwrap();
                match man {
                    Some(v) => {
                        if !m.contains_key(&name) {
                            eprintln!("extension {name} up: {} tool(s)", v["tools"].as_array().map_or(0, Vec::len));
                        }
                        m.insert(name, v);
                    }
                    None => {
                        if m.remove(&name).is_some() {
                            eprintln!("extension {name} down");
                        }
                    }
                }
            }
            let all = st.config.ext.list.iter().all(|(n, _)| st.config.ext.manifests.lock().unwrap().contains_key(n));
            tokio::time::sleep(Duration::from_secs(if all { 60 } else { 3 })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::Profiles;

    fn with(manifest: Value) -> Extensions {
        let x = Extensions { list: vec![("librarian".into(), "http://x".into())], token: None, manifests: Mutex::default() };
        x.manifests.lock().unwrap().insert("librarian".into(), manifest);
        x
    }

    #[test]
    fn tools_are_namespaced_and_scoped() {
        let x = with(json!({ "tools": [
            { "name": "search", "description": "find", "scope": "self", "parameters": { "type": "object", "properties": { "query": { "type": "string" } } } },
            { "name": "flash_board", "description": "writes firmware" },
        ]}));
        let ps = Profiles::load(None);
        let (door, build, review) = (ps.get("coordinator").unwrap(), ps.get("build").unwrap(), ps.get("review").unwrap());
        assert!(x.owns("librarian_search") && x.owns("librarian_flash_board") && !x.owns("librarian_nope") && !x.owns("search"));
        // a self tool: every agent; a world tool (no scope = world): only where the rules allow
        for p in [door, build, review] {
            assert!(x.allows(p, "librarian_search"), "{}", p.name);
        }
        assert!(x.allows(build, "librarian_flash_board"));
        assert!(!x.allows(door, "librarian_flash_board") && !x.allows(review, "librarian_flash_board"));
        let names: Vec<String> = x.schemas(door).iter().map(|s| s["function"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["librarian_search"]);
        assert!(x.schemas(build)[0]["function"]["description"].as_str().unwrap().starts_with("[librarian extension]"));
        assert_eq!(x.prompt(), None, "no manifest prompt, nothing added");
        x.manifests.lock().unwrap().get_mut("librarian").unwrap()["prompt"] = json!("Search past work before saying you don't know.");
        assert_eq!(x.prompt().as_deref(), Some("[extensions]\n- librarian: Search past work before saying you don't know."));
    }

    #[test]
    fn internal_tools_are_never_offered() {
        let x = with(json!({ "tools": [
            { "name": "search", "description": "find", "scope": "self", "parameters": { "type": "object", "properties": {} } },
            { "name": "forget", "description": "delete a fact", "scope": "internal", "parameters": { "type": "object", "properties": {} } },
        ]}));
        let ps = Profiles::load(None);
        let door = ps.get("coordinator").unwrap();
        let names: Vec<String> = x.schemas(door).iter().map(|s| s["function"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["librarian_search"], "internal stays out of the schemas");
        assert!(x.owns("librarian_forget"), "call_internal can still resolve it");
    }

    #[test]
    fn only_a_self_tool_declaring_roots_fans_out() {
        let x = with(json!({ "tools": [
            { "name": "search", "scope": "self", "parameters": { "type": "object", "properties": {
                "query": { "type": "string" }, "roots": { "type": "string" } } } },
            { "name": "recent", "scope": "self", "parameters": { "type": "object", "properties": {} } },
        ]}));
        let (search, recent) = (x.find("librarian_search").unwrap(), x.find("librarian_recent").unwrap());
        assert!(search.roots && !search.world);
        assert!(!recent.roots, "no `roots` declared: always the plain call");
        assert_eq!(x.scope("librarian", "search").as_deref(), Some("self"));
        assert_eq!(x.scope("librarian", "nope"), None);
        assert_eq!(x.scope("other", "search"), None, "not listed / not up");
    }

    #[tokio::test]
    async fn fan_out_labels_hits_per_root_and_lists_an_unreachable_root() {
        let local = async {
            ToolResult { ok: true, title: String::new(), metadata: json!({}),
                output: "- \"Inventory\" (assistant, 2m ago, id=ses_a): use [sqlite]\n- artifact report.md (1h ago): leaks".into() }
        };
        let peers: Vec<String> = ["lab", "mac", "pi"].iter().map(|p| p.to_string()).collect();
        let t0 = std::time::Instant::now();
        let ask = |peer: String| async move {
            match peer.as_str() {
                "lab" => Ok("- \"lab notes\" (id=ses_l): the teal lighthouse ledger\n".to_string()),
                "mac" => Err("root mac unreachable: connection refused".to_string()),
                // never answers: cut at the timeout
                _ => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok("late".to_string())
                }
            }
        };
        let r = fan_out(local, peers, Duration::from_millis(300), ask).await;
        assert!(t0.elapsed() < Duration::from_secs(3), "peers are asked at once, a slow one is cut: {:?}", t0.elapsed());
        assert!(r.ok);
        assert_eq!(r.output, [
            "- [this computer] \"Inventory\" (assistant, 2m ago, id=ses_a): use [sqlite]",
            "- [this computer] artifact report.md (1h ago): leaks",
            "- [lab] \"lab notes\" (id=ses_l): the teal lighthouse ledger",
            "- mac: unreachable",
            "- pi: unreachable",
        ].join("\n"));
        // nothing here, nothing anywhere: still one labelled line per computer
        let local = async { ToolResult { ok: false, title: String::new(), output: "extension librarian unreachable".into(), metadata: json!({}) } };
        let r = fan_out(local, vec!["lab".into()], Duration::from_millis(300), |_| async { Ok("nothing found for 'x'".to_string()) }).await;
        assert!(r.ok, "lab answered");
        assert_eq!(r.output, "- [this computer] extension librarian unreachable\n- [lab] nothing found for 'x'");
    }

    #[test]
    fn the_peer_route_wants_the_peer_token() {
        let p = Peers::new("lab".into(), "", None, None, Some("s3cret".into()), String::new());
        let mut h = HeaderMap::new();
        assert!(!peer_ok(&p, &h), "no token");
        h.insert("x-ygg-peer", "wrong".parse().unwrap());
        assert!(!peer_ok(&p, &h), "wrong token");
        h.insert("x-ygg-peer", "s3cret".parse().unwrap());
        assert!(peer_ok(&p, &h), "the peer token");
        // a root with no peer token configured answers no one on this route
        let open = Peers::new("lab".into(), "", None, None, None, String::new());
        assert!(!peer_ok(&open, &h) && !peer_ok(&open, &HeaderMap::new()));
    }

    fn session(id: &str, title: &str, said: &[(&str, &str, u64)]) -> Session {
        let messages = said
            .iter()
            .map(|(role, text, at)| {
                let mut m = crate::make_message(id, role, vec![crate::text_part(text)]);
                m["info"]["time"]["created"] = json!(at);
                m
            })
            .collect();
        Session { info: json!({ "id": id, "title": title, "time": { "updated": 0 } }), messages, todo: vec![], inbox: vec![] }
    }

    #[test]
    fn the_fallback_search_finds_a_phrase_in_messages_and_skips_test_sessions() {
        let long = format!("{} then the Teal lighthouse LEDGER was filed. {}", "word ".repeat(300), "tail ".repeat(300));
        let mut test = session("ses_t", "e2e", &[("assistant", "the teal lighthouse ledger", 900)]);
        test.info["test"] = json!(true);
        let all = [
            session("ses_old", "notes", &[("user", "reply with exactly: the teal lighthouse ledger", 100), ("assistant", "the teal lighthouse ledger", 110)]),
            session("ses_new", "long one", &[("assistant", &long, 500), ("user", "something else", 600)]),
            session("ses_x", "unrelated", &[("assistant", "a teal boat, a lighthouse", 700)]),
            session("ses_ledger", "Lighthouse ledger", &[("assistant", "the teal one", 300)]),
            test,
        ];
        let out = find_in_sessions(all.iter(), "teal LIGHTHOUSE ledger", 8);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "{out}");
        // newest first; the test session never; the title counts as text of every message
        assert!(lines[0].starts_with("- \"long one\" (id=ses_new): …"), "{out}");
        assert!(lines[0].contains("Teal lighthouse LEDGER was filed") && lines[0].ends_with('…'), "{out}");
        assert!(lines[0].chars().count() <= "- \"long one\" (id=ses_new): ".chars().count() + 200, "{out}");
        assert_eq!(lines[1], "- \"Lighthouse ledger\" (id=ses_ledger): the teal one");
        assert_eq!(lines[2], "- \"notes\" (id=ses_old): the teal lighthouse ledger", "its newest matching message");
        assert!(!out.contains("ses_t)") && !out.contains("ses_x"), "{out}");
        assert_eq!(find_in_sessions(all.iter(), "teal lighthouse ledger", 1).lines().count(), 1, "limit");
        assert_eq!(find_in_sessions(all.iter(), "purple", 8), "nothing found for \"purple\"");
        assert_eq!(find_in_sessions(all.iter(), " ,. ", 8), "say what to look for");
    }
}
