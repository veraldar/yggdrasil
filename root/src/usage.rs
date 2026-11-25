//! Usage checks (harness chains, v10 A2): how much of its plan an engine has used, read BEFORE a
//! turn so a session moves on before it hits the wall, not after.
//!
//! - Claude Code: `GET https://api.anthropic.com/api/oauth/usage` with the sign-in token from
//!   `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR` first) — the call Claude Code's own
//!   `/usage` makes. The 5-hour window and the week count; a week scoped to one model (Fable)
//!   counts for that model only.
//! - z.ai (the root engine on z.ai): `GET https://api.z.ai/api/monitor/usage/quota/limit`, the
//!   key as `Authorization` (no Bearer). Its token windows (5 hours, the week) count; its tool
//!   (`TIME_LIMIT`) budget does not.
//! - Antigravity, opencode, Codex, local providers: no endpoint — no data (errors only).
//!
//! Read-only calls, at most one per engine every 5 minutes (`TTL_MS`), never on a turn's path: a
//! turn reads the cache (`peek`) and a stale entry is refreshed in the background. A quota error a
//! turn actually hit is kept too (`mark_out`) until its reset — the walk skips that engine
//! whatever the numbers say. `YGG_USAGE_CLAUDE_URL` / `YGG_USAGE_ZAI_URL` point the reads
//! elsewhere (`off` = no reads), for sims.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use serde_json::{Value, json};

use crate::provider::{local_time, now_ms, parse_datetime};

/// At or above this share of a window an engine is skipped (v10: "a resting one is skipped").
pub const HIGH: u8 = 90;
/// One read per engine per 5 minutes.
pub const TTL_MS: u64 = 5 * 60_000;
/// A quota error with no reset time we can read: skip the engine this long, then try it again.
pub const OUT_BACKOFF_MS: u64 = 15 * 60_000;
/// A failed read is not retried sooner than this.
const FAIL_TTL_MS: u64 = 60_000;

pub const CLAUDE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// One limit window of a plan.
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    /// `5-hour`, `week`, `week (Fable)`
    pub label: String,
    pub pct: u8,
    pub resets_at: Option<u64>,
    /// counts only for models whose id holds this word (lowercase): Claude's per-model weeks
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Usage {
    pub windows: Vec<Window>,
    pub source: &'static str,
    /// when it was read (ms)
    pub at: u64,
}

impl Usage {
    /// The binding window for `model` (the fullest one that counts for it): (pct, resets_at, label).
    pub fn binding(&self, model: Option<&str>) -> Option<(u8, Option<u64>, String)> {
        let m = model.map(str::to_ascii_lowercase);
        self.windows
            .iter()
            .filter(|w| match (&w.model, &m) {
                (None, _) => true,
                (Some(scope), Some(m)) => m.contains(scope.as_str()),
                (Some(_), None) => false,
            })
            .max_by_key(|w| (w.pct, w.resets_at.unwrap_or(0)))
            .map(|w| (w.pct, w.resets_at, w.label.clone()))
    }
}

/// Where an engine's numbers come from.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Claude { url: String, creds: PathBuf },
    Zai { url: String, key: String },
    None,
}

impl Source {
    pub fn name(&self) -> &'static str {
        match self {
            Source::Claude { .. } => "claude-oauth",
            Source::Zai { .. } => "z.ai",
            Source::None => "none",
        }
    }
}

/// Claude Code's sign-in file: `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/…`.
pub fn claude_creds() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d).join(".credentials.json"),
        None => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude").join(".credentials.json"),
    }
}

fn env_url(k: &str) -> Option<Option<String>> {
    let v = std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())?;
    Some((v != "off").then_some(v))
}

pub fn claude_source() -> Source {
    // unit tests never read the owner's real plan
    #[cfg(test)]
    if env_url("YGG_USAGE_CLAUDE_URL").is_none() {
        return Source::None;
    }
    match env_url("YGG_USAGE_CLAUDE_URL") {
        Some(None) => Source::None,
        Some(Some(url)) => Source::Claude { url, creds: claude_creds() },
        None => Source::Claude { url: CLAUDE_URL.into(), creds: claude_creds() },
    }
}

/// z.ai's quota endpoint for an upstream at `base_url` (z.ai or bigmodel.cn hosts only).
pub fn zai_url_for(base_url: &str) -> Option<String> {
    let (scheme, rest) = base_url.split_once("://")?;
    let host = rest.split('/').next()?;
    let h = host.to_ascii_lowercase();
    (h.ends_with("z.ai") || h.ends_with("bigmodel.cn")).then(|| format!("{scheme}://{host}/api/monitor/usage/quota/limit"))
}

/// The root engine's source: z.ai's numbers when it runs on z.ai with a key
/// (`YGG_USAGE_ZAI_URL` overrides the endpoint for the env upstream).
pub fn zai_source(base_url: &str, key: Option<&str>, env_upstream: bool) -> Source {
    let Some(key) = key.filter(|k| !k.is_empty()) else { return Source::None };
    let url = match env_url("YGG_USAGE_ZAI_URL").filter(|_| env_upstream) {
        Some(None) => return Source::None,
        Some(Some(u)) => Some(u),
        None => zai_url_for(base_url),
    };
    match url {
        Some(url) => Source::Zai { url, key: key.into() },
        None => Source::None,
    }
}

fn pct(v: &Value) -> Option<u8> {
    let f = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().trim_end_matches('%').parse().ok()))?;
    Some(f.round().clamp(0.0, 100.0) as u8)
}

fn when(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().map(|t| if t < 100_000_000_000 { t * 1000 } else { t }),
        Value::String(s) => parse_datetime(s, 0),
        _ => None,
    }
}

/// Claude's usage answer. Today's shape: `limits: [{kind: session | weekly_all | …, percent,
/// resets_at, scope?: {model: {display_name}}}]`; the older one: `five_hour` / `seven_day` /
/// `seven_day_opus` / `seven_day_sonnet` `{utilization, resets_at}`.
pub fn parse_claude(v: &Value) -> Option<Vec<Window>> {
    let mut out = Vec::new();
    for l in v["limits"].as_array().into_iter().flatten() {
        let Some(p) = pct(&l["percent"]).or_else(|| pct(&l["utilization"])) else { continue };
        let scope = l["scope"]["model"]["display_name"].as_str().map(|n| n.split_whitespace().next().unwrap_or(n).to_ascii_lowercase());
        let label = match (l["kind"].as_str().unwrap_or_default(), &scope) {
            ("session", _) => "5-hour".to_string(),
            (_, Some(m)) => format!("week ({m})"),
            ("weekly_all", None) => "week".to_string(),
            (k, None) => k.replace('_', " "),
        };
        out.push(Window { label, pct: p, resets_at: when(&l["resets_at"]), model: scope });
    }
    for (key, label, model) in [
        ("five_hour", "5-hour", None),
        ("seven_day", "week", None),
        ("seven_day_opus", "week (opus)", Some("opus")),
        ("seven_day_sonnet", "week (sonnet)", Some("sonnet")),
    ] {
        let w = &v[key];
        if let Some(p) = pct(&w["utilization"]).or_else(|| pct(&w["percent"])) {
            out.push(Window { label: label.into(), pct: p, resets_at: when(&w["resets_at"]), model: model.map(String::from) });
        }
    }
    (!out.is_empty()).then_some(out)
}

/// z.ai's answer: `{data: {limits: [{type, unit, number, percentage, nextResetTime}]}}`.
pub fn parse_zai(v: &Value) -> Option<Vec<Window>> {
    let d = if v["data"].is_object() { &v["data"] } else { v };
    let mut out = Vec::new();
    for l in d["limits"].as_array().into_iter().flatten() {
        // the tool budget (web search…) is not the model's quota
        if l["type"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("TIME_LIMIT")) {
            continue;
        }
        let Some(p) = pct(&l["percentage"]) else { continue };
        let n = l["number"].as_u64().unwrap_or(1);
        let span = match l["unit"].as_u64() {
            Some(3) => "hour",
            Some(5) => "day",
            Some(6) => "week",
            _ => "window",
        };
        let label = if n == 1 { span.to_string() } else { format!("{n}-{span}") };
        out.push(Window { label, pct: p, resets_at: when(&l["nextResetTime"]), model: None });
    }
    (!out.is_empty()).then_some(out)
}

/// One read, now. `Err` = no numbers this time (no token, refused, unreachable, unknown shape).
pub async fn fetch(http: &reqwest::Client, src: &Source) -> Result<Usage, String> {
    let (req, parse): (reqwest::RequestBuilder, fn(&Value) -> Option<Vec<Window>>) = match src {
        Source::None => return Err("no usage endpoint".into()),
        Source::Claude { url, creds } => {
            let raw = std::fs::read(creds).map_err(|e| format!("{}: {e}", creds.display()))?;
            let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", creds.display()))?;
            let o = &v["claudeAiOauth"];
            let token = o["accessToken"].as_str().filter(|t| !t.is_empty()).ok_or("no Claude sign-in token")?;
            if o["expiresAt"].as_u64().is_some_and(|t| t < now_ms()) {
                return Err("the Claude sign-in token has expired (Claude Code renews it on its next run)".into());
            }
            let req = http
                .get(url)
                .bearer_auth(token)
                .header("anthropic-beta", "oauth-2025-04-20")
                .header("user-agent", "claude-cli")
                .header("accept", "application/json");
            (req, parse_claude)
        }
        Source::Zai { url, key } => (http.get(url).header("authorization", key).header("accept", "application/json"), parse_zai),
    };
    let resp = req.timeout(Duration::from_secs(8)).send().await.map_err(|e| format!("unreachable: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
    let windows = parse(&v).ok_or("no usage windows in the answer")?;
    Ok(Usage { windows, source: src.name(), at: now_ms() })
}

#[derive(Default)]
struct Cache {
    read: HashMap<String, Usage>,
    failed: HashMap<String, (u64, String)>,
    fetching: HashSet<String>,
    /// a quota error a turn hit: until when, and its words
    out: HashMap<String, (u64, String)>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

/// `TTL_MS`, or `YGG_USAGE_TTL_MS` (sims read again sooner).
fn ttl() -> u64 {
    std::env::var("YGG_USAGE_TTL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(TTL_MS)
}

fn fresh(key: &str, now: u64) -> bool {
    let ttl = ttl();
    let c = CACHE.lock().unwrap();
    c.read.get(key).is_some_and(|u| now.saturating_sub(u.at) < ttl) || c.failed.get(key).is_some_and(|(at, _)| now.saturating_sub(*at) < FAIL_TTL_MS.min(ttl))
}

fn store(key: &str, r: Result<Usage, String>) {
    let mut c = CACHE.lock().unwrap();
    c.fetching.remove(key);
    match r {
        Ok(u) => {
            c.failed.remove(key);
            c.read.insert(key.to_string(), u);
        }
        Err(e) => {
            c.failed.insert(key.to_string(), (now_ms(), e));
        }
    }
}

/// What the cache holds for `key` — never waits. A stale entry (or none) starts one read in the
/// background, so the next turn has numbers. The last good numbers stay until replaced.
pub fn peek(http: &reqwest::Client, key: &str, src: &Source) -> Option<Usage> {
    let now = now_ms();
    if *src != Source::None && !fresh(key, now) {
        let start = CACHE.lock().unwrap().fetching.insert(key.to_string());
        if start {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                let (http, key, src) = (http.clone(), key.to_string(), src.clone());
                rt.spawn(async move {
                    let r = fetch(&http, &src).await;
                    if let Err(e) = &r {
                        eprintln!("usage: {key}: {e}");
                    }
                    store(&key, r);
                });
            } else {
                CACHE.lock().unwrap().fetching.remove(key);
            }
        }
    }
    CACHE.lock().unwrap().read.get(key).cloned()
}

/// Reads now when stale (GET /usage waits for it; turns never do).
pub async fn read(http: &reqwest::Client, key: &str, src: &Source) -> Option<Usage> {
    if *src != Source::None && !fresh(key, now_ms()) {
        let r = fetch(http, src).await;
        if let Err(e) = &r {
            eprintln!("usage: {key}: {e}");
        }
        store(key, r);
    }
    CACHE.lock().unwrap().read.get(key).cloned()
}

/// The last read failure for `key` (shown on GET /usage), if newer than the last good read.
pub fn last_error(key: &str) -> Option<String> {
    let c = CACHE.lock().unwrap();
    let (at, e) = c.failed.get(key)?;
    (c.read.get(key).is_none_or(|u| u.at < *at)).then(|| e.clone())
}

/// The spec's view: the engine's fullest window — (pct, resets_at) — from the cache.
#[allow(dead_code)]
pub fn usage_pct(key: &str) -> Option<(u8, Option<u64>)> {
    let u = CACHE.lock().unwrap().read.get(key).cloned()?;
    u.binding(None).map(|(p, r, _)| (p, r))
}

/// A turn on `key` hit a hard quota: skip it until `until` (else the binding window's reset when
/// the numbers say it is full, else `OUT_BACKOFF_MS`); the numbers are read again soon.
pub fn mark_out(key: &str, until: Option<u64>, why: &str) {
    let now = now_ms();
    let mut c = CACHE.lock().unwrap();
    let from_numbers = c.read.get(key).and_then(|u| u.binding(None)).filter(|(p, _, _)| *p >= HIGH).and_then(|(_, r, _)| r);
    let until = until.or(from_numbers).filter(|t| *t > now).unwrap_or(now + OUT_BACKOFF_MS);
    c.out.insert(key.to_string(), (until, why.chars().take(200).collect()));
    // the numbers that let it run are old news now
    if let Some(u) = c.read.get_mut(key) {
        u.at = 0;
    }
    c.failed.remove(key);
}

/// A turn on `key` went through: whatever error was seen is over.
pub fn mark_ok(key: &str) {
    CACHE.lock().unwrap().out.remove(key);
}

pub fn out_until(key: &str) -> Option<(u64, String)> {
    let now = now_ms();
    let c = CACHE.lock().unwrap();
    c.out.get(key).filter(|(t, _)| *t > now).cloned()
}

/// What the walk sees for one engine + model.
#[derive(Clone, Debug, PartialEq)]
pub enum Avail {
    /// below `HIGH`, or no numbers at all (`None`): it gets its try
    Clear(Option<u8>),
    /// at or above `HIGH` (not full): skipped while something else clears
    High { pct: u8, window: String, resets_at: Option<u64> },
    /// full, or a quota error was seen and has not reset
    Out { why: String, resets_at: Option<u64> },
}

impl Avail {
    pub fn clears(&self) -> bool {
        matches!(self, Avail::Clear(_))
    }

    pub fn out(&self) -> bool {
        matches!(self, Avail::Out { .. })
    }

    /// `92% of the 5-hour window, resets 23:30` — one plain clause.
    pub fn say(&self) -> String {
        let at = |r: &Option<u64>| r.map(|t| format!(", resets {}", short_time(t))).unwrap_or_default();
        match self {
            Avail::Clear(Some(p)) => format!("{p}% used"),
            Avail::Clear(None) => "no usage numbers".into(),
            Avail::High { pct, window, resets_at } => format!("{pct}% of its {window} window used{}", at(resets_at)),
            Avail::Out { why, resets_at } => format!("{why}{}", at(resets_at)),
        }
    }

    pub fn resets_at(&self) -> Option<u64> {
        match self {
            Avail::Clear(_) => None,
            Avail::High { resets_at, .. } | Avail::Out { resets_at, .. } => *resets_at,
        }
    }
}

/// `HH:MM` today, else `YYYY-MM-DD HH:MM`, in the root's zone.
pub fn short_time(t: u64) -> String {
    let full = local_time(t);
    let today = local_time(now_ms());
    match (full.get(..10), today.get(..10)) {
        (Some(d), Some(n)) if d == n => full.get(11..).unwrap_or(&full).to_string(),
        _ => full,
    }
}

/// Pure: what `usage` + a seen error mean for `model`.
pub fn judge(usage: Option<&Usage>, out: Option<(u64, String)>, model: Option<&str>) -> Avail {
    if let Some((until, why)) = out {
        return Avail::Out { why: format!("hit its limit ({})", why.trim()), resets_at: Some(until) };
    }
    match usage.and_then(|u| u.binding(model)) {
        Some((p, r, label)) if p >= 100 => Avail::Out { why: format!("its {label} window is used up"), resets_at: r },
        Some((p, r, label)) if p >= HIGH => Avail::High { pct: p, window: label, resets_at: r },
        Some((p, _, _)) => Avail::Clear(Some(p)),
        None => Avail::Clear(None),
    }
}

/// The cache-backed verdict for `key` (starts a background read when stale).
pub fn avail(http: &reqwest::Client, key: &str, src: &Source, model: Option<&str>) -> Avail {
    let u = peek(http, key, src);
    judge(u.as_ref(), out_until(key), model)
}

/// One engine's row on GET /usage.
pub fn row(key: &str, src: &Source, u: Option<&Usage>) -> Value {
    let mut v = json!({ "source": src.name(), "pct": Value::Null, "resets_at": Value::Null });
    if let Some(u) = u {
        if let Some((p, r, label)) = u.binding(None) {
            v["pct"] = json!(p);
            v["resets_at"] = json!(r);
            v["window"] = json!(label);
        }
        v["windows"] = json!(u.windows.iter().map(|w| json!({ "label": w.label, "pct": w.pct, "resets_at": w.resets_at, "model": w.model })).collect::<Vec<_>>());
        v["checked_at"] = json!(u.at);
    }
    if let Some((until, why)) = out_until(key) {
        v["out"] = json!({ "until": until, "why": why });
    }
    if let Some(e) = last_error(key) {
        v["error"] = json!(e);
    }
    v
}

#[cfg(test)]
pub fn set_for_test(key: &str, windows: Vec<Window>) {
    let mut c = CACHE.lock().unwrap();
    c.read.insert(key.to_string(), Usage { windows, source: "test", at: now_ms() });
    c.failed.remove(key);
    c.out.remove(key);
}

#[cfg(test)]
pub fn clear_for_test(key: &str) {
    let mut c = CACHE.lock().unwrap();
    c.read.remove(key);
    c.failed.remove(key);
    c.out.remove(key);
    c.fetching.remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::HeaderMap, routing::get};

    /// what api.anthropic.com/api/oauth/usage answered on omarchy (11-21), trimmed
    fn claude_now() -> Value {
        json!({ "limits": [
            { "kind": "session", "percent": 100, "resets_at": "2026-11-22T00:09:00.000000+00:00" },
            { "kind": "weekly_all", "percent": 59, "resets_at": "2026-11-22T20:59:00+00:00" },
            { "kind": "weekly_model", "percent": 96, "resets_at": "2026-11-22T20:59:00+00:00", "scope": { "model": { "display_name": "Fable" } } }
        ], "extra_usage": { "is_enabled": false } })
    }

    #[test]
    fn claude_both_shapes() {
        let w = parse_claude(&claude_now()).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!((w[0].label.as_str(), w[0].pct), ("5-hour", 100));
        assert_eq!(w[0].resets_at, parse_datetime("2026-11-22T00:09:00Z", 0));
        assert_eq!((w[2].label.as_str(), w[2].model.as_deref()), ("week (fable)", Some("fable")));
        let old = json!({ "five_hour": { "utilization": 92.4, "resets_at": "2026-11-24T23:00:00+00:00" },
            "seven_day": { "utilization": 40.0, "resets_at": "2026-11-29T20:00:00+00:00" }, "seven_day_opus": null });
        let w = parse_claude(&old).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].label.as_str(), w[0].pct), ("5-hour", 92));
        let u = Usage { windows: w, source: "claude-oauth", at: 0 };
        assert_eq!(u.binding(None).unwrap().0, 92);
        assert!(parse_claude(&json!({ "error": "nope" })).is_none());
    }

    #[test]
    fn a_model_scoped_week_counts_for_that_model_only() {
        let u = Usage { windows: parse_claude(&json!({ "limits": [
            { "kind": "session", "percent": 40, "resets_at": "2026-11-22T00:09:00Z" },
            { "kind": "weekly_model", "percent": 96, "resets_at": "2026-11-22T20:59:00Z", "scope": { "model": { "display_name": "Fable" } } }
        ] })).unwrap(), source: "claude-oauth", at: now_ms() };
        assert!(matches!(judge(Some(&u), None, Some("fable")), Avail::High { pct: 96, .. }));
        assert_eq!(judge(Some(&u), None, Some("sonnet")), Avail::Clear(Some(40)));
        assert_eq!(judge(Some(&u), None, None), Avail::Clear(Some(40)));
    }

    #[test]
    fn zai_windows_skip_the_tool_budget() {
        let v = json!({ "code": 200, "data": { "level": "pro", "limits": [
            { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "usage": 12000, "currentValue": 11040, "remaining": 960, "percentage": 92, "nextResetTime": 1_795_000_000_000u64 },
            { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "usage": 60000, "currentValue": 14018, "remaining": 45982, "percentage": 23, "nextResetTime": 1_795_500_000_000u64 },
            { "type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 1000, "currentValue": 1000, "percentage": 100, "nextResetTime": 1_796_000_000_000u64 }
        ] } });
        let w = parse_zai(&v).unwrap();
        assert_eq!(w.len(), 2, "the tool budget is not the model's quota");
        assert_eq!((w[0].label.as_str(), w[0].pct, w[0].resets_at), ("5-hour", 92, Some(1_795_000_000_000)));
        assert_eq!(w[1].label, "week");
        let u = Usage { windows: w, source: "z.ai", at: now_ms() };
        assert!(matches!(judge(Some(&u), None, None), Avail::High { pct: 92, .. }));
        assert!(parse_zai(&json!({ "data": { "limits": [] } })).is_none());
    }

    #[test]
    fn verdicts() {
        let w = |p: u8| Usage { windows: vec![Window { label: "5-hour".into(), pct: p, resets_at: Some(5), model: None }], source: "t", at: 0 };
        assert_eq!(judge(Some(&w(89)), None, None), Avail::Clear(Some(89)));
        assert!(matches!(judge(Some(&w(90)), None, None), Avail::High { pct: 90, .. }));
        assert!(judge(Some(&w(100)), None, None).out());
        assert_eq!(judge(None, None, None), Avail::Clear(None), "no numbers = it gets its try");
        assert!(judge(Some(&w(10)), Some((9, "5-hour limit".into())), None).out(), "a seen quota error wins over old numbers");
        assert!(Avail::Clear(None).clears() && !judge(Some(&w(95)), None, None).clears());
    }

    #[test]
    fn zai_endpoint_from_the_upstream() {
        assert_eq!(zai_url_for("https://api.z.ai/api/anthropic").as_deref(), Some("https://api.z.ai/api/monitor/usage/quota/limit"));
        assert_eq!(zai_url_for("https://open.bigmodel.cn/api/paas/v4").as_deref(), Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit"));
        assert_eq!(zai_url_for("http://127.0.0.1:11434/v1"), None);
        assert_eq!(zai_source("https://api.z.ai/api/anthropic", None, false), Source::None, "no key, no read");
    }

    #[test]
    fn mark_out_then_ok() {
        let k = "test-mark-out";
        clear_for_test(k);
        mark_out(k, None, "You've hit your 5-hour limit");
        let (until, why) = out_until(k).unwrap();
        assert!(until > now_ms() + OUT_BACKOFF_MS - 5_000 && why.contains("5-hour"));
        // numbers that say full give the reset instead of the backoff
        set_for_test(k, vec![Window { label: "5-hour".into(), pct: 100, resets_at: Some(now_ms() + 3_600_000 * 3), model: None }]);
        mark_out(k, None, "limit");
        assert!(out_until(k).unwrap().0 > now_ms() + 3_600_000 * 2);
        mark_ok(k);
        assert!(out_until(k).is_none());
        clear_for_test(k);
    }

    /// The real HTTP calls against a local stand-in: the token and the key go where they should.
    #[tokio::test]
    async fn fetch_reads_both_endpoints() {
        let seen: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let (s1, s2) = (seen.clone(), seen.clone());
        let app = Router::new()
            .route("/api/oauth/usage", get(move |h: HeaderMap| {
                let s1 = s1.clone();
                async move {
                    s1.lock().unwrap().push(format!("claude {} {}", h["authorization"].to_str().unwrap(), h["anthropic-beta"].to_str().unwrap()));
                    axum::Json(json!({ "five_hour": { "utilization": 95.0, "resets_at": "2026-11-24T23:00:00Z" } }))
                }
            }))
            .route("/api/monitor/usage/quota/limit", get(move |h: HeaderMap| {
                let s2 = s2.clone();
                async move {
                    s2.lock().unwrap().push(format!("zai {}", h["authorization"].to_str().unwrap()));
                    axum::Json(json!({ "data": { "limits": [{ "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 3, "nextResetTime": 1_795_000_000_000u64 }] } }))
                }
            }))
            .route("/refuse", get(|| async { (axum::http::StatusCode::UNAUTHORIZED, "no") }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let srv = tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let dir = std::env::temp_dir().join(format!("ygg-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let creds = dir.join(".credentials.json");
        std::fs::write(&creds, json!({ "claudeAiOauth": { "accessToken": "tok-123", "expiresAt": now_ms() + 3_600_000 } }).to_string()).unwrap();
        let http = reqwest::Client::new();

        let c = fetch(&http, &Source::Claude { url: format!("http://{addr}/api/oauth/usage"), creds: creds.clone() }).await.unwrap();
        assert_eq!(c.binding(None).unwrap().0, 95);
        let z = fetch(&http, &Source::Zai { url: format!("http://{addr}/api/monitor/usage/quota/limit"), key: "zk-9".into() }).await.unwrap();
        assert_eq!(z.binding(None).unwrap().0, 3);
        assert_eq!(seen.lock().unwrap().as_slice(), &["claude Bearer tok-123 oauth-2025-04-20".to_string(), "zai zk-9".to_string()], "z.ai takes the key without Bearer");
        // refused, no token, expired token: no numbers
        assert!(fetch(&http, &Source::Zai { url: format!("http://{addr}/refuse"), key: "k".into() }).await.unwrap_err().contains("401"));
        std::fs::write(&creds, json!({ "claudeAiOauth": { "accessToken": "tok", "expiresAt": 1 } }).to_string()).unwrap();
        assert!(fetch(&http, &Source::Claude { url: format!("http://{addr}/api/oauth/usage"), creds: creds.clone() }).await.is_err());
        assert!(fetch(&http, &Source::Claude { url: format!("http://{addr}/api/oauth/usage"), creds: dir.join("missing") }).await.is_err());

        // the cache: a read fills it, a peek within the TTL never calls again
        let k = "test-read-cache";
        clear_for_test(k);
        std::fs::write(&creds, json!({ "claudeAiOauth": { "accessToken": "tok-123" } }).to_string()).unwrap();
        let src = Source::Claude { url: format!("http://{addr}/api/oauth/usage"), creds };
        let n0 = seen.lock().unwrap().len();
        assert_eq!(read(&http, k, &src).await.unwrap().binding(None).unwrap().0, 95);
        assert_eq!(usage_pct(k).map(|x| x.0), Some(95));
        assert!(matches!(avail(&http, k, &src, None), Avail::High { pct: 95, .. }));
        let _ = read(&http, k, &src).await;
        assert_eq!(seen.lock().unwrap().len(), n0 + 1, "one call per TTL");
        clear_for_test(k);
        srv.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
