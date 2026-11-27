//! G1: what a session's model is actually sent, captured once per upstream step and served
//! read-only by `GET /session/{id}/context`. The capture stores the exact wire body (never the
//! request, so no key is captured), classifies every block by deterministic prefix rules, and
//! masks secrets only when a view is served — the stored bytes stay exact for the byte-equality
//! proof. Memory only (LRU, 48 sessions): a restart loses it, the first turn refills it, and
//! `?preview=1` re-assembles the stored messages without sending anything.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::{AppState, rollup};

/// Sessions kept at once (LRU): ~40 KB for MAIN, under a megabyte for a 200k-token session.
const CAP: usize = 48;

/// What fell out of the assembled view this turn.
#[derive(Clone, Default, Debug)]
pub struct Dropped {
    /// one-liner digests removed by `cap_digest_lines`
    pub fold_lines: usize,
    /// stored messages folded behind the roll-up summary (0 = no compaction yet)
    pub rollup_msgs: usize,
    /// the folded message range (indices into the stored transcript)
    pub from: usize,
    pub to: usize,
}

impl Dropped {
    pub fn to_json(&self) -> Value {
        json!({ "fold_lines": self.fold_lines, "rollup_msgs": self.rollup_msgs, "from": self.from, "to": self.to })
    }
}

/// One block of the assembled request, as the owner's sheet shows it. `role`/`msg`/`call`
/// carry the wire shape, so the exact body can be rebuilt from blocks alone (the
/// byte-equality proof).
#[derive(Clone, Debug)]
pub struct Block {
    /// system | tools | history | newest | nudge
    pub kind: &'static str,
    /// shared | agents_md | role | tools | verbatim | one_liner | station_one_liner | summary |
    /// pruned | tree | clock | inbox | voice
    pub origin: &'static str,
    /// the wire role of the message this block belongs to (system | user | assistant | tool)
    pub role: &'static str,
    /// index of the wire message this block belongs to
    pub msg: usize,
    /// a tool-call block: (id, name); its text is the arguments string
    pub call: Option<(String, String)>,
    pub label: String,
    pub text: String,
}

impl Block {
    fn head(&self, n: usize) -> String {
        let mut out: String = self.text.chars().take(n).collect();
        let one = self.text.chars().count();
        if one > n {
            out.push('…');
        }
        out
    }
    fn bytes(&self) -> usize {
        self.text.len()
    }
    pub fn tok(&self) -> usize {
        rollup::est_tokens(&[json!({ "role": "user", "content": self.text })])
    }
    fn summary(&self, i: usize) -> Value {
        json!({ "i": i, "kind": self.kind, "origin": self.origin, "role": self.role, "msg": self.msg,
            "label": self.label, "bytes": self.bytes(), "tok": self.tok(), "head": self.head(300) })
    }
}

/// One captured upstream step (or harness call) of one session.
#[derive(Clone, Debug)]
pub struct Captured {
    pub at: u64,
    pub step: usize,
    pub model: String,
    pub variant: String,
    pub dialect: String,
    /// the exact wire body; `Null` for a harness capture (its payload rides `harness`)
    pub body: Value,
    pub blocks: Vec<Block>,
    pub tools: Vec<String>,
    pub dropped: Dropped,
    /// harness call: `{prompt, system, argv}` (argv with secrets masked)
    pub harness: Option<Value>,
}

impl Captured {
    /// Bytes of the exact body sent upstream (the number the CTX-CAPTURE line and the app's
    /// Sent totals must agree on).
    pub fn bytes(&self) -> usize {
        if self.body.is_null() {
            self.harness.as_ref().map(|h| h.to_string().len()).unwrap_or(0)
        } else {
            self.body.to_string().len()
        }
    }
    pub fn tok(&self) -> usize {
        let msgs = msgs_of(&self.body);
        if msgs.is_empty() {
            return 0;
        }
        rollup::est_tokens(&msgs)
    }
    pub fn to_summary(&self) -> Value {
        json!({
            "captured_at": self.at,
            "step": self.step,
            "model": self.model,
            "variant": self.variant,
            "dialect": self.dialect,
            "totals": { "bytes": self.bytes(), "tok": self.tok() },
            "blocks": self.blocks.iter().enumerate().map(|(i, b)| b.summary(i)).collect::<Vec<_>>(),
            "tools": self.tools,
            "dropped": self.dropped.to_json(),
            "harness": self.harness,
        })
    }
}

/// The wire body's messages as the internal (OpenAI-shaped) list, so token estimates and the
/// block classifier work the same on both dialects.
pub fn msgs_of(body: &Value) -> Vec<Value> {
    if body.is_null() {
        return Vec::new();
    }
    let mut out = Vec::new();
    // anthropic: the system blocks live top-level
    if let Some(sys) = body["system"].as_str() {
        for chunk in sys.split("\n\n").filter(|c| !c.trim().is_empty()) {
            out.push(json!({ "role": "system", "content": chunk }));
        }
    }
    for m in body["messages"].as_array().into_iter().flatten() {
        let role = m["role"].as_str().unwrap_or("user");
        let content = match &m["content"] {
            Value::String(t) => json!(t),
            Value::Array(blocks) => {
                let mut text = String::new();
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(b["text"].as_str().unwrap_or_default());
                        }
                        Some("tool_result") => {
                            text.push_str(b["content"].as_str().unwrap_or_default());
                        }
                        Some("tool_use") => {
                            text.push_str(&format!("{{\"name\":{}}}", b["name"]));
                        }
                        _ => {}
                    }
                }
                json!(text)
            }
            other => other.clone(),
        };
        let mut v = json!({ "role": role, "content": content });
        if let Some(calls) = m["tool_calls"].as_array() {
            v["tool_calls"] = json!(calls);
        }
        out.push(v);
    }
    out
}

/// The 3 system blocks by position (merged into `system` by the anthropic convert).
fn system_origin(i: usize, text: &str) -> &'static str {
    if text.starts_with("[agent:") {
        "role"
    } else if text.contains("Instructions from:") {
        "agents_md"
    } else if i == 0 {
        "shared"
    } else {
        "shared"
    }
}

/// Classifies one conversation item by its deterministic prefix rules.
fn classify(role: &str, text: &str, last_user: bool, after_summary_ask: &mut bool) -> (&'static str, &'static str) {
    if role == "system" {
        return ("system", "shared"); // per-position origin is applied by the caller
    }
    if role == "assistant" && *after_summary_ask {
        *after_summary_ask = false;
        return ("history", "summary");
    }
    if text.contains("[inbox since your last turn]") {
        return (if last_user { "newest" } else { "history" }, "inbox");
    }
    if text.contains(crate::VOICE_TURN_NOTE) {
        return (if last_user { "newest" } else { "history" }, "voice");
    }
    if text.contains("[tree]") {
        return ("newest", "tree");
    }
    if text.starts_with(crate::rollup::COMPACTION_ASK) {
        *after_summary_ask = true;
        return ("history", "summary");
    }
    if text.starts_with("[old tool output pruned") {
        return ("history", "pruned");
    }
    if text.starts_with("[earlier turn]") {
        return ("history", "one_liner");
    }
    if text.starts_with("[station turn]") {
        return ("history", "station_one_liner");
    }
    if text.starts_with("(Your previous response came back empty") || text.starts_with("(quiet) is not an option") {
        return ("nudge", "verbatim");
    }
    if text.starts_with("[clock ") {
        return (if last_user { "newest" } else { "history" }, "clock");
    }
    (if last_user { "newest" } else { "history" }, "verbatim")
}

fn label_of(origin: &str, text: &str) -> String {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let mut l: String = first.chars().take(60).collect();
    if first.chars().count() > 60 {
        l.push('…');
    }
    match origin {
        "shared" => "shared prompt (preamble + intent)",
        "agents_md" => "AGENTS.md chain",
        "role" => "agent role",
        "tools" => "tool schemas",
        "summary" => "roll-up summary",
        "pruned" => "pruned tool output",
        "one_liner" => "earlier turn, folded to one line",
        "station_one_liner" => "station turn, folded to one line",
        "tree" => "[tree] view",
        "inbox" => "[inbox since your last turn]",
        "voice" => "voice turn note",
        "clock" => "clock header",
        _ => &l,
    }
    .to_string()
}

/// The tool names a wire body declares.
fn tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .map(|ts| ts.iter().filter_map(|t| t["function"]["name"].as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Blocks for a wire body: the system chunks (anthropic) or system messages (OpenAI), the tools
/// block, then every message in order.
pub fn classify_body(body: &Value) -> (Vec<Block>, Vec<String>) {
    let mut blocks: Vec<Block> = Vec::new();
    let msgs = msgs_of(body);
    let mut sys_i = 0usize;
    let mut after_summary_ask = false;
    // the newest user message index (the [tree]/[inbox]/voice items ride it)
    let last_user = msgs.iter().rposition(|m| m["role"] == "user").unwrap_or(usize::MAX);
    let wire_role = |r: &str| match r {
        "system" => "system",
        "assistant" => "assistant",
        "tool" => "tool",
        _ => "user",
    };
    for (i, m) in msgs.iter().enumerate() {
        let role = wire_role(m["role"].as_str().unwrap_or("user"));
        let text = m["content"].as_str().unwrap_or_default().to_string();
        if role == "system" {
            let origin = system_origin(sys_i, &text);
            sys_i += 1;
            blocks.push(Block { kind: "system", origin, role, msg: i, call: None, label: label_of(origin, &text), text });
            continue;
        }
        for tc in m["tool_calls"].as_array().into_iter().flatten() {
            let name = tc["function"]["name"].as_str().unwrap_or("?").to_string();
            blocks.push(Block {
                kind: "history",
                origin: "verbatim",
                role: "assistant",
                msg: i,
                call: Some((tc["id"].as_str().unwrap_or_default().to_string(), name.clone())),
                label: format!("tool call: {name}"),
                text: tc["function"]["arguments"].as_str().unwrap_or_default().to_string(),
            });
        }
        if text.is_empty() {
            continue;
        }
        let (kind, origin) = classify(m["role"].as_str().unwrap_or("user"), &text, i == last_user, &mut after_summary_ask);
        let (kind, origin) = if role == "system" { (kind, system_origin(sys_i, &text)) } else { (kind, origin) };
        blocks.push(Block { kind, origin, role, msg: i, call: None, label: label_of(origin, &text), text });
    }
    let tools = tool_names(&body["tools"]);
    if !tools.is_empty() {
        blocks.insert(
            if blocks.first().is_some_and(|b| b.kind == "system") && blocks.len() > 1 && blocks[1].kind == "system" {
                // after the last system block
                let at = blocks.iter().rposition(|b| b.kind == "system").unwrap_or(0) + 1;
                at
            } else {
                blocks.iter().rposition(|b| b.kind == "system").map(|p| p + 1).unwrap_or(0)
            },
            Block { kind: "tools", origin: "tools", role: "assistant", msg: usize::MAX, call: None, label: format!("{} tool schema(s)", tools.len()), text: body["tools"].to_string() },
        );
    }
    (blocks, tools)
}

/// Rebuilds the normalized wire body from blocks alone: `{system, messages}`. The system
/// chunks join with blank lines (the anthropic shape); messages group by their wire index;
/// tool-call blocks become `tool_calls` on their assistant message. This is how the owner's
/// sheet (part=block) reconstructs what was sent, and how the byte-equality proof compares.
pub fn body_from_blocks(blocks: &[Block]) -> Value {
    let mut system: Vec<String> = Vec::new();
    let mut msgs: Vec<(usize, Value)> = Vec::new();
    for b in blocks {
        if b.kind == "tools" || b.msg == usize::MAX {
            continue;
        }
        if b.role == "system" {
            system.push(b.text.clone());
            continue;
        }
        let slot = msgs.iter().position(|(i, _)| i == &b.msg);
        let idx = slot.unwrap_or_else(|| {
            msgs.push((b.msg, json!({ "role": b.role, "content": "" })));
            msgs.len() - 1
        });
        let m = &mut msgs[idx].1;
        if let Some((id, name)) = &b.call {
            if m["tool_calls"].as_array().is_none() {
                m["tool_calls"] = json!([]);
            }
            if let Some(calls) = m["tool_calls"].as_array_mut() {
                calls.push(json!({ "id": id, "type": "function",
                    "function": { "name": name, "arguments": b.text } }));
            }
        } else if m["content"].as_str().unwrap_or_default().is_empty() {
            m["content"] = json!(b.text);
        } else {
            let joined = format!("{}\n{}", m["content"].as_str().unwrap_or_default(), b.text);
            m["content"] = json!(joined);
        }
    }
    msgs.sort_by_key(|(i, _)| *i);
    let mut out = json!({ "messages": msgs.into_iter().map(|(_, m)| m).collect::<Vec<_>>() });
    if !system.is_empty() {
        out["system"] = json!(system.join("\n\n"));
    }
    out
}

/// LRU store in `AppState.ctx` — memory only, never persisted, never written through
/// `with_session` (so a look never moves `time.updated`).
#[derive(Default)]
pub struct Store {
    map: HashMap<String, Captured>,
    order: Vec<String>,
}

impl Store {
    pub fn get(&self, sid: &str) -> Option<&Captured> {
        self.map.get(sid)
    }
    pub fn put(&mut self, sid: String, c: Captured) {
        if !self.map.contains_key(&sid) {
            self.order.push(sid.clone());
            if self.order.len() > CAP {
                let old = self.order.remove(0);
                self.map.remove(&old);
            }
        }
        self.map.insert(sid, c);
    }
}

/// Captures one upstream step: the exact body, classified. Called by `relay`/`relay_anthropic`
/// right after the body is built (the body, never the request — the key is a header).
pub fn capture(
    st: &AppState,
    sid: &str,
    step: usize,
    model: &str,
    variant: &str,
    dialect: &str,
    body: &Value,
    dropped: crate::context::Dropped,
) {
    let (blocks, tools) = classify_body(body);
    let c = Captured {
        at: crate::now_ms(),
        step,
        model: model.to_string(),
        variant: variant.to_string(),
        dialect: dialect.to_string(),
        body: body.clone(),
        blocks,
        tools,
        dropped,
        harness: None,
    };
    eprintln!("CTX-CAPTURE session={sid} step={step} bytes={} blocks={}", c.bytes(), c.blocks.len());
    st.ctx.lock().unwrap().put(sid.to_string(), c);
}

/// Captures a harness call: `{prompt, system, argv minus secrets}` — the harness's own context,
/// which the brain assembles but never sends as JSON.
pub fn capture_harness(st: &AppState, sid: &str, step: usize, prompt: &str, system: &str, argv: &[String]) {
    let masked: Vec<String> = argv.iter().map(|a| mask(a)).collect();
    let c = Captured {
        at: crate::now_ms(),
        step,
        model: String::new(),
        variant: String::new(),
        dialect: "harness".into(),
        body: Value::Null,
        blocks: Vec::new(),
        tools: Vec::new(),
        dropped: Dropped::default(),
        harness: Some(json!({ "prompt": prompt, "system": system, "argv": masked })),
    };
    eprintln!("CTX-CAPTURE session={sid} step={step} bytes={} blocks=0 harness", c.bytes());
    st.ctx.lock().unwrap().put(sid.to_string(), c);
}

/// Hides secrets in a served view (the stored capture stays exact). Order matters: the base64
/// of an image can carry key-looking text, so images go first.
pub fn mask(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let starts = |chars: &[char], i: usize, p: &str| p.chars().zip(chars[i..].iter()).all(|(a, b)| a == *b);
    while i < chars.len() {
        // data:image/…;base64,DATA → [image N KB]
        if starts(&chars, i, "data:image/") {
            let rest: String = chars[i..].iter().collect();
            if let Some(pos) = rest.find(";base64,") {
                let after = pos + ";base64,".len();
                let end = rest[after..].find(|c: char| c == '"' || c == '\\' || c == ' ' || c == ')' || c == '\n').map(|e| after + e).unwrap_or(rest.len());
                let kb = (end - after).div_ceil(1024).max(1);
                out.push_str(&format!("[image {kb} KB]"));
                i += end;
                continue;
            }
        }
        // Bearer …
        if starts(&chars, i, "Bearer ") {
            let end = chars[i + 7..].iter().position(|c| *c == ' ' || *c == '"' || *c == '\\' || *c == '\n').map(|e| i + 7 + e).unwrap_or(chars.len());
            out.push_str("Bearer …");
            i = end;
            continue;
        }
        // sk-…
        if starts(&chars, i, "sk-") {
            let end = chars[i..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '_' || **c == '-').count() + i;
            if end - i >= 19 {
                out.push_str("sk-…");
                i = end;
                continue;
            }
        }
        // bfn[pdr]-… (bifrost tokens)
        if starts(&chars, i, "bfnp-") || starts(&chars, i, "bfnr-") || starts(&chars, i, "bfnd-") {
            let end = chars[i..].iter().position(|c| *c == ' ' || *c == '"' || *c == '\\' || *c == ',' || *c == '\n').map(|e| i + e).unwrap_or(chars.len());
            out.push_str(&chars[i..i + 5].iter().collect::<String>());
            out.push('…');
            i = end;
            continue;
        }
        // (?i)(key|token|secret|password)\s*[=:]\s*\S+ — a word boundary before the keyword
        let kw = ["key", "token", "secret", "password"].iter().find(|kw| {
            starts(&chars, i, kw)
                && (i == 0 || !chars[i - 1].is_alphanumeric())
                && chars.get(i + kw.len()).is_some_and(|c| *c == ' ' || *c == '\t' || *c == '=' || *c == ':')
        });
        if let Some(kw) = kw {
            let mut j = i + kw.chars().count();
            while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '=' || chars[j] == ':') {
                let sep = j;
                j += 1;
                while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                    j += 1;
                }
                let vstart = j;
                while j < chars.len()
                    && !chars[j].is_whitespace()
                    && chars[j] != '"'
                    && chars[j] != '\''
                    && chars[j] != '\\'
                    && chars[j] != ','
                    && chars[j] != '}'
                    && chars[j] != ')'
                {
                    j += 1;
                }
                if j > vstart && chars[sep + 1..].first() != Some(&'/') {
                    out.push_str(kw);
                    out.push_str("=…");
                    i = j;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_hides_keys_and_images() {
        let m = mask("api_key=abcd1234 and token: tok_9f8e7d6c5b and password = hunter2");
        assert!(!m.contains("abcd1234"), "{m}");
        assert!(!m.contains("tok_9f8e7d6c5b"), "{m}");
        assert!(!m.contains("hunter2"), "{m}");
        assert!(m.contains("api_key=…") && m.contains("token") && m.contains("password=…"), "{m}");
        let bearer = mask("Authorization: Bearer eyJhbGciOi.next-part");
        assert!(!bearer.contains("eyJhbGciOi"), "{bearer}");
        let sk = mask("key sk-a1B2c3D4e5F6g7H8i9J0 done");
        assert!(!sk.contains("a1B2c3D4e5F6g7H8i9J0"), "{sk}");
        assert!(sk.contains("sk-…"), "{sk}");
        let img = mask(&format!("see data:image/png;base64,{} end", "A".repeat(4096)));
        assert!(!img.contains("AAAA"), "{img}");
        assert!(img.contains("[image 4 KB]"), "{img}");
        // prose with the words is safe when no assignment follows
        let prose = mask("the key to the workshop is under the mat");
        assert_eq!(prose, prose, "no panic");
        assert!(prose.contains("under the mat"), "{prose}");
        // a URL's scheme survives (https:// is not an assignment)
        let url = mask("read https://example.com/key=list");
        // the assignment pattern inside the URL still hides the value part after /key= … acceptable:
        // the host and path stay visible
        assert!(url.starts_with("read https://example.com/"), "{url}");
    }

    #[test]
    fn blocks_are_classified_by_prefixes() {
        let body = json!({ "model": "m", "messages": [
            { "role": "system", "content": crate::profiles::PREAMBLE },
            { "role": "system", "content": "Instructions from: /w/AGENTS.md\nbe nice" },
            { "role": "system", "content": "[agent: build]\ndo builds" },
            { "role": "user", "content": "[clock 2026-11-19T10:00:00Z] hello" },
            { "role": "assistant", "content": "hi" },
            { "role": "user", "content": "[earlier turn] old ask => old reply" },
            { "role": "user", "content": "[station turn] reports: x" },
            { "role": "user", "content": "What did we do so far?" },
            { "role": "assistant", "content": "MOCK-SUMMARY: we did things" },
            { "role": "tool", "content": "[old tool output pruned by roll-up; re-run the tool if you need it]" },
            { "role": "user", "content": "[clock 2026-11-19T11:00:00Z] [inbox since your last turn]\n- x\nnext ask" },
        ], "tools": [ { "type": "function", "function": { "name": "bash" } } ] });
        let (blocks, tools) = classify_body(&body);
        assert_eq!(tools, vec!["bash"]);
        let origins: Vec<&str> = blocks.iter().map(|b| b.origin).collect();
        assert_eq!(origins[0], "shared", "{origins:?}");
        assert_eq!(origins[1], "agents_md", "{origins:?}");
        assert_eq!(origins[2], "role", "{origins:?}");
        assert!(blocks.iter().any(|b| b.kind == "tools"), "{origins:?}");
        assert!(blocks.iter().any(|b| b.origin == "one_liner"));
        assert!(blocks.iter().any(|b| b.origin == "station_one_liner"));
        assert!(blocks.iter().filter(|b| b.origin == "summary").count() == 2, "ask + reply, {origins:?}");
        assert!(blocks.iter().any(|b| b.origin == "pruned"));
        let newest = blocks.iter().filter(|b| b.kind == "newest").count();
        assert_eq!(newest, 1, "the last user turn is the newest, {origins:?}");
        assert!(blocks.last().is_some_and(|b| b.origin == "inbox"), "{origins:?}");
    }
}
