//! The meter — the trunk's own counts and timings (trunk observability, proposal v2).
//!
//! Passive and cheap: every number here is an atomic added to where the traffic already is
//! (once per connection, never per packet), and one background tick a minute turns them into
//! ONE line per process: `<dir>/<proc>-min-YYYY-MM-DD.jsonl`. Things that happen (a link
//! down, a peer cut, a probe, a refresh…) are event lines in `<dir>/<proc>-events-….jsonl`,
//! written by a thread behind a bounded queue: a full queue drops and counts, it never waits.
//!
//! Content is never recorded: no bodies, no query strings, no session ids, no tokens or
//! token hashes, no full IP addresses — route classes, sizes, timings, statuses, reasons.
//!
//! No config key (every config is `deny_unknown_fields`, and a rollback must keep starting):
//!   BIFROST_OBS=off            nothing is written (the counters still count, unread)
//!   BIFROST_OBS_DIR=<dir>      where the files go; else the caller's default (beside its
//!                              state) — or memory only (the access point: the VPS keeps
//!                              nothing on disk, it sends its minutes home over the channel)
//! Files older than KEEP_DAYS are deleted by the writer itself (no report job needed for that).

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

/// minute lines and events are kept this many days (proposal §5.6)
pub const KEEP_DAYS: u64 = 14;
/// minutes kept in memory (for `/_obs`, and the ap's backlog while the channel is down)
pub const RING: usize = 60;
/// one day's event file stops growing past this (a flood must not fill the disk)
const MAX_EVENTS_FILE: u64 = 64 << 20;

// ---- counters, peaks and histograms: statics, no lock, no allocation --------------------------

macro_rules! meter_set {
    (counters { $($c:ident = $cn:literal),* $(,)? }
     peaks { $($p:ident = $pn:literal),* $(,)? }
     levels { $($l:ident = $ln:literal),* $(,)? }
     hists { $($h:ident = $hn:literal),* $(,)? }) => {
        /// counters (reset every minute; the line carries the minute's delta)
        pub struct Counters { $(pub $c: AtomicU64,)* }
        pub static C: Counters = Counters { $($c: AtomicU64::new(0),)* };
        fn counters() -> Vec<(&'static str, &'static AtomicU64)> { vec![$(($cn, &C.$c)),*] }
        /// peaks (the highest value seen this minute; reset every minute)
        pub struct Peaks { $(pub $p: AtomicU64,)* }
        pub static P: Peaks = Peaks { $($p: AtomicU64::new(0),)* };
        fn peaks() -> Vec<(&'static str, &'static AtomicU64)> { vec![$(($pn, &P.$p)),*] }
        /// levels (a current value: read, never reset)
        pub struct Levels { $(pub $l: AtomicU64,)* }
        pub static L: Levels = Levels { $($l: AtomicU64::new(0),)* };
        fn levels() -> Vec<(&'static str, &'static AtomicU64)> { vec![$(($ln, &L.$l)),*] }
        /// latency histograms (microseconds in, p50/p95/p99 in ms out)
        pub struct Hists { $(pub $h: Hist,)* }
        pub static H: Hists = Hists { $($h: Hist::new(),)* };
        fn hists() -> Vec<(&'static str, &'static Hist)> { vec![$(($hn, &H.$h)),*] }
    };
}

meter_set! {
    counters {
        // -- the edge, on the VPS (ap.rs serve / edge_conn / raw_conn) --
        edge_conns = "edge.conns",
        edge_proxy_timeout = "edge.proxy.timeout",
        edge_proxy_bad = "edge.proxy.bad",
        edge_tls_ok = "edge.tls.ok",
        edge_tls_timeout = "edge.tls.timeout",
        edge_tls_fail = "edge.tls.fail",
        edge_head_timeout = "edge.head.timeout",
        edge_head_bad = "edge.head.bad",
        edge_streams = "edge.streams",
        edge_offline = "edge.offline",
        edge_bytes_in = "edge.bytes.in",
        edge_bytes_out = "edge.bytes.out",
        edge_raw = "edge.raw",
        edge_raw_nolink = "edge.raw.nolink",
        edge_ice_peek_stun = "edge.ice.stun",
        edge_link_up = "edge.link.up",
        edge_link_refused = "edge.link.refused",
        edge_link_down_silent = "edge.link.down.silent",
        edge_link_down_error = "edge.link.down.error",
        edge_link_down_closed = "edge.link.down.closed",
        edge_link_down_taken = "edge.link.down.taken",
        edge_probe_ok = "edge.probe.ok",
        edge_probe_fail = "edge.probe.fail",
        // -- the channel, from home (ap.rs dial_forever / dial_once) --
        link_up = "link.up",
        link_fail_connect = "link.fail.connect",
        link_fail_tls = "link.fail.tls",
        link_fail_upgrade = "link.fail.upgrade",
        link_down_silent = "link.down.silent",
        link_down_error = "link.down.error",
        link_down_closed = "link.down.closed",
        link_stats_in = "link.stats.in",
        // -- edge streams as the bridge serves them (ap.rs serve_stream) --
        streams = "streams",
        streams_tunnel = "streams.tunnel",
        gate_ok = "gate.ok",
        gate_missing = "gate.deny.missing",
        gate_invalid = "gate.deny.invalid",
        gate_expired = "gate.deny.expired",
        gate_region = "gate.deny.region",
        gate_revoked = "gate.deny.revoked",
        gate_hint_refresh = "gate.hint.refresh",
        gate_hint_pair = "gate.hint.pair",
        up_connect_fail = "up.connect.fail",
        status_2xx = "status.2xx",
        status_3xx = "status.3xx",
        status_4xx = "status.4xx",
        status_5xx = "status.5xx",
        status_101 = "status.101",
        bytes_in = "bytes.in",
        bytes_out = "bytes.out",
        // -- the probe (5-minute test request) --
        probe_home_ok = "probe.home.ok",
        probe_home_fail = "probe.home.fail",
        probe_answered = "probe.answered",
        probe_refused = "probe.refused",
        // -- pinned peers (bridge.rs) --
        offer = "peer.offer",
        offer_ok = "peer.offer.ok",
        offer_denied = "peer.offer.denied",
        offer_bad = "peer.offer.bad",
        peer_admit = "peer.admit",
        peer_open = "peer.open",
        peer_cut_revoked = "peer.cut.revoked",
        peer_cut_kill = "peer.cut.kill",
        peer_cut_expired = "peer.cut.expired",
        peer_gone = "peer.gone",
        peer_path_udp = "peer.path.udp",
        peer_path_tcp = "peer.path.tcp",
        refresh_ok = "peer.refresh.ok",
        refresh_denied = "peer.refresh.denied",
        refresh_late = "peer.refresh.late",
        tun_streams = "peer.tunnel.streams",
        dtls_rxq_full = "peer.dtls.rxq_full",
        log_warn = "log.warn",
        log_error = "log.error",
        log_suppressed = "log.suppressed",
        rtc_cut_revoked = "rtc.cut.revoked",
        // -- root links (rootlink.rs, switch.rs) --
        root_link_up = "root.link.up",
        root_link_refused = "root.link.refused",
        root_link_down = "root.link.down",
        root_calls = "root.calls",
        root_calls_5xx = "root.calls.5xx",
        root_calls_504 = "root.calls.504",
        // -- WireGuard node (wg.rs, its own counters folded in) --
        wg_cut_revoked = "wg.cut.revoked",
        // -- the meter itself --
        obs_dropped = "obs.dropped",
    }
    peaks {
        loop_lag_us = "bridge.loop.lag_us",
        loop_inputs = "bridge.loop.inputs",
        tun_backlog = "peer.tunnel.backlog",
        streams_open = "streams.open",
        link_queue_bytes = "link.queue.frames",
        edge_queue_bytes = "edge.queue.frames",
    }
    levels {
        peers = "peers",
        link = "link",
        edge_link = "edge.link",
        roots_linked = "roots.linked",
        streams_now = "streams.now",
    }
    hists {
        edge_tls = "edge.tls",
        edge_ttfb = "edge.ttfb",
        edge_dur = "edge.dur",
        edge_probe = "edge.probe",
        edge_probe_link = "edge.probe.link",
        link_rtt = "link.rtt",
        link_connect = "link.connect",
        ttfb = "ttfb",
        ttfb_tunnel = "ttfb.tunnel",
        dur = "dur",
        up_connect = "up.connect",
        probe_home = "probe.home",
        offer_answer = "peer.offer.answer",
        peer_open_ms = "peer.open",
        refresh_lead = "peer.refresh.lead",
        revoke_cut = "revoke.cut",
        root_rtt = "root.rtt",
        root_call = "root.call",
        loop_iter = "bridge.loop",
    }
}

/// Add one.
#[inline]
pub fn inc(c: &AtomicU64) {
    c.fetch_add(1, Relaxed);
}

/// Add n.
#[inline]
pub fn add(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Relaxed);
}

/// Raise a peak.
#[inline]
pub fn peak(p: &AtomicU64, v: u64) {
    p.fetch_max(v, Relaxed);
}

/// Set a level.
#[inline]
pub fn set(l: &AtomicU64, v: u64) {
    l.store(v, Relaxed);
}

/// A counter whose name is known only at run time (log targets): a small locked map, used
/// on rare paths only (a warning line, never a packet).
pub fn inc_named(name: &str) {
    let mut m = named().lock().unwrap_or_else(|e| e.into_inner());
    *m.entry(name.to_string()).or_insert(0) += 1;
}

fn named() -> &'static Mutex<HashMap<String, u64>> {
    static N: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

// ---- histogram: log-scale buckets, 4 per power of two (~19 % wide), 1 µs … ~12 days ------------

const NB: usize = 160;

pub struct Hist {
    b: [AtomicU64; NB],
}

impl Hist {
    pub const fn new() -> Hist {
        Hist { b: [const { AtomicU64::new(0) }; NB] }
    }

    /// Record a value in microseconds.
    #[inline]
    pub fn us(&self, us: u64) {
        self.b[bucket(us)].fetch_add(1, Relaxed);
    }

    /// Record a duration.
    #[inline]
    pub fn dur(&self, d: Duration) {
        self.us(d.as_micros().min(u64::MAX as u128) as u64);
    }

    /// Record the time since `t0`.
    #[inline]
    pub fn since(&self, t0: Instant) {
        self.dur(t0.elapsed());
    }

    fn take(&self) -> [u64; NB] {
        let mut out = [0u64; NB];
        for (o, b) in out.iter_mut().zip(self.b.iter()) {
            *o = b.swap(0, Relaxed);
        }
        out
    }
}

impl Default for Hist {
    fn default() -> Self {
        Hist::new()
    }
}

pub fn bucket(us: u64) -> usize {
    if us < 4 {
        return us as usize;
    }
    let lz = 63 - us.leading_zeros() as usize; // ≥ 2
    let sub = ((us >> (lz - 2)) & 3) as usize;
    (4 * (lz - 1) + sub).min(NB - 1)
}

/// The middle of a bucket, in microseconds.
pub fn bucket_mid(i: usize) -> f64 {
    if i < 4 {
        return i as f64;
    }
    let lz = i / 4 + 1;
    let sub = (i % 4) as u64;
    let lo = (4 + sub) << (lz - 2);
    let hi = (5 + sub) << (lz - 2);
    (lo + hi) as f64 / 2.0
}

/// {n, p50, p95, p99, max} in milliseconds (None when the minute saw nothing).
pub fn summarize(b: &[u64; NB]) -> Option<Value> {
    let n: u64 = b.iter().sum();
    if n == 0 {
        return None;
    }
    let q = |p: f64| -> f64 {
        let want = ((p * n as f64).ceil() as u64).max(1);
        let mut acc = 0;
        for (i, c) in b.iter().enumerate() {
            acc += c;
            if acc >= want {
                return bucket_mid(i);
            }
        }
        bucket_mid(NB - 1)
    };
    let max = b.iter().rposition(|c| *c > 0).map(bucket_mid).unwrap_or(0.0);
    let ms = |us: f64| (us / 100.0).round() / 10.0;
    Some(json!({ "n": n, "p50": ms(q(0.50)), "p95": ms(q(0.95)), "p99": ms(q(0.99)), "max": ms(max) }))
}

// ---- the process's meter: init, the minute tick, events, files --------------------------------

struct Meter {
    proc_: String,
    dir: Option<PathBuf>,
    rel: String,
    events: SyncSender<Msg>,
    ring: Mutex<VecDeque<Value>>,
    totals: Mutex<Map<String, Value>>,
    /// minute lines other processes sent this one (the ap's, over the channel): proc → ring
    foreign: Mutex<HashMap<String, VecDeque<Value>>>,
    hooks: Mutex<Vec<Box<dyn Fn(&Value) + Send>>>,
    sources: Mutex<Vec<(String, Box<dyn Fn() -> Option<Value> + Send>)>>,
    started: u64,
}

/// What the writer thread writes: an event, or a minute line another process sent (the ap's).
enum Msg {
    Event(String, Value),
    Foreign(String, Value),
}

static M: OnceLock<Meter> = OnceLock::new();
static OFF: AtomicBool = AtomicBool::new(false);

/// Is the meter writing (BIFROST_OBS is not `off`)?
pub fn enabled() -> bool {
    !OFF.load(Relaxed) && M.get().is_some()
}

/// The folder the files go to: BIFROST_OBS_DIR, else `default` (None = memory only).
pub fn dir_from_env(default: Option<PathBuf>) -> Option<PathBuf> {
    match std::env::var("BIFROST_OBS_DIR") {
        Ok(d) if !d.trim().is_empty() => Some(PathBuf::from(d.trim())),
        _ => default,
    }
}

/// The default folder beside a state file: `<state file's folder>/../obs`
/// (on the hub: ~/.local/share/yggdrasil/hub/state/devices.json → hub/obs).
pub fn dir_beside(state_file: &std::path::Path) -> Option<PathBuf> {
    let folder = state_file.parent()?;
    let folder = if folder.as_os_str().is_empty() { std::path::Path::new(".") } else { folder };
    Some(folder.join("..").join("obs"))
}

/// The release this binary runs from: `…/releases/<id>/bin/bifrost-net` → `<id>`, else the
/// crate version.
pub fn release_id() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| {
            let parts: Vec<String> = p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            parts.iter().position(|c| c == "releases").and_then(|i| parts.get(i + 1).cloned())
        })
        .unwrap_or_else(|| concat!("v", env!("CARGO_PKG_VERSION")).to_string())
}

/// Start this process's meter (once; later calls are ignored). `dir` None = memory only.
pub fn init(proc_: &str, dir: Option<PathBuf>) {
    if std::env::var("BIFROST_OBS").is_ok_and(|v| v.eq_ignore_ascii_case("off") || v == "0") {
        OFF.store(true, Relaxed);
        return;
    }
    if M.get().is_some() {
        return;
    }
    if let Some(d) = &dir {
        // device ids and regions live here: the owner's eyes only (like the state folder)
        match std::fs::create_dir_all(d) {
            Ok(()) => {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
            }
            Err(e) => eprintln!("  meter: {}: {e} — memory only", d.display()),
        }
    }
    let dir = dir.filter(|d| d.is_dir());
    let (tx, rx) = sync_channel::<Msg>(8192);
    let m = Meter {
        proc_: proc_.to_string(),
        dir: dir.clone(),
        rel: release_id(),
        events: tx,
        ring: Mutex::new(VecDeque::with_capacity(RING)),
        totals: Mutex::new(Map::new()),
        foreign: Mutex::new(HashMap::new()),
        hooks: Mutex::new(vec![]),
        sources: Mutex::new(vec![]),
        started: now_ms(),
    };
    if M.set(m).is_err() {
        return;
    }
    let p = proc_.to_string();
    std::thread::Builder::new()
        .name("meter-events".into())
        .spawn(move || event_writer(p, dir, rx))
        .expect("meter events thread");
    std::thread::Builder::new().name("meter-tick".into()).spawn(tick_loop).expect("meter tick thread");
    match M.get().and_then(|m| m.dir.as_ref()) {
        Some(d) => println!("  meter: on — {} (one line a minute; events; {KEEP_DAYS} days)", d.display()),
        None => println!("  meter: on — memory only (last {RING} minutes)"),
    }
}

/// Run `f` with every minute line this process makes (the ap sends it home).
pub fn on_minute(f: impl Fn(&Value) + Send + 'static) {
    if let Some(m) = M.get() {
        m.hooks.lock().unwrap_or_else(|e| e.into_inner()).push(Box::new(f));
    }
}

/// Numbers another part of the process already keeps (the WireGuard node's own counters):
/// asked once a minute, written into the line under `key`.
pub fn add_source(key: &str, f: impl Fn() -> Option<Value> + Send + 'static) {
    if let Some(m) = M.get() {
        m.sources.lock().unwrap_or_else(|e| e.into_inner()).push((key.to_string(), Box::new(f)));
    }
}

/// One event line: `{t, kind, …fields}`. Never blocks: a full queue drops it and counts.
pub fn event(kind: &str, fields: Value) {
    let Some(m) = M.get() else { return };
    if OFF.load(Relaxed) {
        return;
    }
    match m.events.try_send(Msg::Event(kind.to_string(), fields)) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => inc(&C.obs_dropped),
    }
}

/// A minute line another process made (the ap's, arrived over the channel): kept in memory
/// and written as `<proc>-min-….jsonl` beside ours. The line is untrusted input — the
/// caller caps its size; here it must be a JSON object with a numeric `ts`.
pub fn ingest(proc_: &str, line: Value) -> bool {
    let Some(m) = M.get() else { return false };
    // only the access point sends lines home, and only lines of the last few hours: a hostile
    // VPS can neither pick a file's name nor date it (the writer names it `ap-min-<that day>`)
    let now = now_ms();
    let ts_ok = line.get("ts").and_then(Value::as_u64).is_some_and(|t| t + 3 * 3_600_000 >= now && t <= now + 300_000);
    if !line.is_object() || !ts_ok || !ALLOWED_FOREIGN.contains(&proc_) {
        return false;
    }
    {
        let mut f = m.foreign.lock().unwrap_or_else(|e| e.into_inner());
        let r = f.entry(proc_.to_string()).or_default();
        let ts = line["ts"].as_u64();
        if r.iter().any(|x| x["ts"].as_u64() == ts) {
            return true; // a backlog resent after a reconnect
        }
        if r.len() >= RING {
            r.pop_front();
        }
        r.push_back(line.clone());
    }
    // the file write happens on the writer thread, never on the caller's (the channel's runtime)
    if m.dir.is_some() && m.events.try_send(Msg::Foreign(proc_.to_string(), line)).is_err() {
        inc(&C.obs_dropped);
    }
    true
}

/// The processes whose minute lines this one takes in (over the channel): the access point only.
const ALLOWED_FOREIGN: [&str; 1] = ["ap"];

/// What `GET /_obs` answers: this process's last hour, the totals since start, and the
/// minute lines other processes sent (the ap's).
pub fn snapshot() -> Value {
    let Some(m) = M.get() else { return json!({ "on": false }) };
    let ring: Vec<Value> = m.ring.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    let foreign: Map<String, Value> = m
        .foreign
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), Value::Array(v.iter().cloned().collect())))
        .collect();
    json!({
        "on": !OFF.load(Relaxed), "proc": m.proc_, "release": m.rel, "since": m.started,
        "dir": m.dir.as_ref().map(|d| d.display().to_string()),
        "minutes": ring, "totals": Value::Object(m.totals.lock().unwrap_or_else(|e| e.into_inner()).clone()), "from": foreign,
    })
}

/// The last minute lines + totals, for sending home (the ap's backlog after a reconnect).
pub fn backlog() -> (Vec<Value>, Value) {
    let Some(m) = M.get() else { return (vec![], json!({})) };
    let ring = m.ring.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    (ring, Value::Object(m.totals.lock().unwrap_or_else(|e| e.into_inner()).clone()))
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn tick_loop() {
    loop {
        // wake on the minute boundary (wall clock), so every process's lines line up
        let ms = now_ms();
        std::thread::sleep(Duration::from_millis(60_000 - ms % 60_000 + 5));
        let mut line = minute_line();
        let Some(m) = M.get() else { return };
        {
            let mut t = m.totals.lock().unwrap_or_else(|e| e.into_inner());
            add_totals(&mut t, &line);
            if m.dir.is_none() {
                // memory only (the VPS): every line carries the totals since start, so an outage
                // longer than the ring loses the minutes' detail, never a count
                line["tot"] = Value::Object(t.clone());
            }
        }
        {
            let mut r = m.ring.lock().unwrap_or_else(|e| e.into_inner());
            if r.len() >= RING {
                r.pop_front();
            }
            r.push_back(line.clone());
        }
        if let Some(d) = &m.dir {
            if !OFF.load(Relaxed) {
                append(d, &format!("{}-min-{}.jsonl", m.proc_, day(now_ms())), &line);
            }
        }
        for h in m.hooks.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            h(&line);
        }
        crate::meter::logrl::flush();
    }
}

/// The minute's line: counters' deltas and peaks (both reset), levels, histogram summaries,
/// and the run-time named counters. Zero values are left out.
pub fn minute_line() -> Value {
    let (proc_, rel) = M.get().map(|m| (m.proc_.clone(), m.rel.clone())).unwrap_or_default();
    let mut c = Map::new();
    for (name, a) in counters() {
        let v = a.swap(0, Relaxed);
        if v > 0 {
            c.insert(name.into(), v.into());
        }
    }
    for (name, v) in std::mem::take(&mut *named().lock().unwrap_or_else(|e| e.into_inner())) {
        c.insert(name, v.into());
    }
    for (name, a) in ROUTES.iter().zip(ROUTE_N.iter()) {
        let v = a.swap(0, Relaxed);
        if v > 0 {
            c.insert(format!("edge.route.{name}"), v.into());
        }
    }
    let mut g = Map::new();
    for (name, a) in peaks() {
        let v = a.swap(0, Relaxed);
        if v > 0 {
            g.insert(name.into(), v.into());
        }
    }
    for (name, a) in levels() {
        g.insert(name.into(), a.load(Relaxed).into());
    }
    let mut h = Map::new();
    for (name, hist) in hists() {
        if let Some(s) = summarize(&hist.take()) {
            h.insert(name.into(), s);
        }
    }
    let ts = now_ms();
    let mut line = json!({ "ts": ts / 60_000 * 60_000, "t": iso(ts), "proc": proc_, "rel": rel, "c": c, "g": g, "h": h });
    if let Some(p) = proc_stats() {
        line["p"] = p;
    }
    if let Some(m) = M.get() {
        for (k, f) in m.sources.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if let Some(v) = f() {
                line[k.as_str()] = v;
            }
        }
    }
    line
}

fn add_totals(t: &mut Map<String, Value>, line: &Value) {
    if let Some(c) = line["c"].as_object() {
        for (k, v) in c {
            let n = t.get(k).and_then(Value::as_u64).unwrap_or(0) + v.as_u64().unwrap_or(0);
            t.insert(k.clone(), n.into());
        }
    }
}

/// This process from /proc/self: cpu seconds (user+system), rss bytes, open files, threads.
fn proc_stats() -> Option<Value> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after = stat.rsplit_once(')')?.1;
    let f: Vec<&str> = after.split_whitespace().collect();
    // fields after ")" start at index 2 (state): utime = 14th field overall → f[11], stime f[12],
    // threads f[17], rss pages f[21]
    let tick = 100.0; // USER_HZ on Linux
    let cpu = (f.get(11)?.parse::<f64>().ok()? + f.get(12)?.parse::<f64>().ok()?) / tick;
    let threads: u64 = f.get(17)?.parse().ok()?;
    let rss_pages: u64 = f.get(21)?.parse().ok()?;
    let fds = std::fs::read_dir("/proc/self/fd").map(|d| d.count()).unwrap_or(0);
    Some(json!({ "cpu_s": (cpu * 100.0).round() / 100.0, "rss": rss_pages * 4096, "fds": fds, "threads": threads }))
}

fn event_writer(proc_: String, dir: Option<PathBuf>, rx: Receiver<Msg>) {
    let mut last_sweep = 0u64;
    while let Ok(msg) = rx.recv() {
        let Some(d) = &dir else { continue };
        if OFF.load(Relaxed) {
            continue;
        }
        let (kind, fields) = match msg {
            Msg::Event(k, f) => (k, f),
            Msg::Foreign(from, line) => {
                let ts = line["ts"].as_u64().unwrap_or(0);
                append(d, &format!("{from}-min-{}.jsonl", day(ts)), &line);
                continue;
            }
        };
        let ts = now_ms();
        let mut line = json!({ "ts": ts, "t": iso(ts), "kind": kind });
        if let (Some(o), Value::Object(f)) = (line.as_object_mut(), fields) {
            for (k, v) in f {
                o.insert(k, v);
            }
        }
        let name = format!("{proc_}-events-{}.jsonl", day(ts));
        if std::fs::metadata(d.join(&name)).map(|m| m.len()).unwrap_or(0) > MAX_EVENTS_FILE {
            inc(&C.obs_dropped);
            continue;
        }
        append(d, &name, &line);
        if ts / 3_600_000 != last_sweep {
            last_sweep = ts / 3_600_000;
            sweep(d);
        }
    }
}

fn append(dir: &std::path::Path, name: &str, line: &Value) {
    use std::os::unix::fs::OpenOptionsExt;
    let mut s = line.to_string();
    s.push('\n');
    // device ids and regions: the owner's eyes only (a new file is 0600)
    let r = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join(name))
        .and_then(|mut f| f.write_all(s.as_bytes()));
    if r.is_err() {
        inc(&C.obs_dropped);
    }
}

/// Delete `*-YYYY-MM-DD.jsonl[.gz]` files older than KEEP_DAYS (the report keeps its own
/// hourly roll-ups elsewhere).
pub fn sweep(dir: &std::path::Path) {
    let cutoff = day(now_ms().saturating_sub(KEEP_DAYS * 86_400_000));
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let stem = n.trim_end_matches(".gz").trim_end_matches(".jsonl");
        if !n.is_ascii() || stem.len() < 10 || !(n.ends_with(".jsonl") || n.ends_with(".jsonl.gz")) {
            continue;
        }
        let d = &stem[stem.len() - 10..];
        if d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' && d < cutoff.as_str() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// `YYYY-MM-DD` (UTC) of a unix-ms time.
pub fn day(ms: u64) -> String {
    iso(ms)[..10].to_string()
}

/// RFC 3339 UTC, second precision.
pub fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let (d, s) = (secs / 86_400, secs % 86_400);
    // civil from days (Howard Hinnant)
    let z = d as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mm <= 2 { y + 1 } else { y };
    format!("{yy:04}-{mm:02}-{dd:02}T{:02}:{:02}:{:02}Z", s / 3600, s % 3600 / 60, s % 60)
}

/// The route classes `route_class` can answer, each with its own counter (no lock per stream).
const ROUTES: [&str; 25] = [
    "page", "api.session", "api.session.messages", "api.session.abort", "api.session.one", "api.run-events",
    "api.pair.refresh", "api.pair.claim", "api.pair", "api.file", "api.artifact", "api.roots", "api.tree",
    "api.voice", "api.diag", "api.other", "rtc", "offer", "identity", "branch", "rootlink", "probe", "static",
    "", "",
];
static ROUTE_N: [AtomicU64; 25] = [const { AtomicU64::new(0) }; 25];

/// Count one stream of this route class at the edge (written as `edge.route.<class>`).
pub fn route_inc(class: &str) {
    if let Some(i) = ROUTES.iter().position(|r| !r.is_empty() && *r == class) {
        ROUTE_N[i].fetch_add(1, Relaxed);
    }
}

/// Route class of a request path: a fixed name, never the path itself (no ids, no query).
pub fn route_class(path: &str) -> &'static str {
    let p = path.split(['?', '#']).next().unwrap_or("");
    let seg: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    match seg.as_slice() {
        [] => "page",
        ["api", "session"] => "api.session",
        ["api", "session", _, "messages", ..] => "api.session.messages",
        ["api", "session", _, "abort"] => "api.session.abort",
        ["api", "session", ..] => "api.session.one",
        ["api", "run-events", ..] => "api.run-events",
        ["api", "pair", "refresh"] => "api.pair.refresh",
        ["api", "pair", "claim"] => "api.pair.claim",
        ["api", "pair", ..] => "api.pair",
        ["api", "file", ..] => "api.file",
        ["api", "artifact", ..] => "api.artifact",
        ["api", "roots", ..] => "api.roots",
        ["api", "tree", ..] => "api.tree",
        ["api", "token" | "tts" | "dispatch" | "ice", ..] => "api.voice",
        ["api", "diag", ..] => "api.diag",
        ["api", ..] => "api.other",
        ["rtc", ..] => "rtc",
        ["offer"] => "offer",
        ["identity"] => "identity",
        ["branch"] => "branch",
        ["rootlink"] => "rootlink",
        ["_probe"] => "probe",
        ["_next", ..] | ["sw.js"] | ["manifest.json"] | ["favicon.ico"] | ["icons", ..] => "static",
        _ => "page",
    }
}

// ---- log rate limit: the first line of a kind each minute, then "N more" ---------------------

pub mod logrl {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    /// callsite → (minute, suppressed this minute, what it was)
    fn state() -> &'static Mutex<HashMap<String, (u64, u64, String)>> {
        static S: OnceLock<Mutex<HashMap<String, (u64, u64, String)>>> = OnceLock::new();
        S.get_or_init(Default::default)
    }

    /// Should this line be printed? `key` names the callsite (target + line).
    pub fn allow(key: &str, what: &str) -> bool {
        let minute = super::now_ms() / 60_000;
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        let e = s.entry(key.to_string()).or_insert((0, 0, what.to_string()));
        if e.0 != minute {
            if e.1 > 0 {
                eprintln!("{} {} more '{}' lines that minute (counted, not printed)", super::iso(e.0 * 60_000), e.1, e.2);
            }
            *e = (minute, 0, what.to_string());
            return true;
        }
        e.1 += 1;
        super::inc(&super::C.log_suppressed);
        false
    }

    /// Print the "N more" lines of minutes that are over (the meter tick calls it).
    pub fn flush() {
        let minute = super::now_ms() / 60_000;
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        for (_, e) in s.iter_mut() {
            if e.0 != minute && e.1 > 0 {
                eprintln!("{} {} more '{}' lines that minute (counted, not printed)", super::iso(e.0 * 60_000), e.1, e.2);
                e.1 = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_monotonic_and_tight() {
        let mut last = 0;
        for us in [0u64, 1, 3, 4, 5, 7, 8, 100, 1_000, 10_000, 999_999, 60_000_000] {
            let b = bucket(us);
            assert!(b >= last, "bucket({us}) = {b} < {last}");
            last = b;
            if us >= 4 {
                let mid = bucket_mid(b);
                assert!((mid - us as f64).abs() / (us as f64) < 0.25, "mid {mid} far from {us}");
            }
        }
        assert_eq!(bucket(u64::MAX), NB - 1);
    }

    #[test]
    fn summary_percentiles() {
        let h = Hist::new();
        for _ in 0..90 {
            h.us(1_000); // 1 ms
        }
        for _ in 0..10 {
            h.us(100_000); // 100 ms
        }
        let s = summarize(&h.take()).unwrap();
        assert_eq!(s["n"], 100);
        let p50 = s["p50"].as_f64().unwrap();
        let p95 = s["p95"].as_f64().unwrap();
        assert!((0.8..1.3).contains(&p50), "p50 {p50}");
        assert!((80.0..130.0).contains(&p95), "p95 {p95}");
        assert!(summarize(&h.take()).is_none(), "take() resets");
    }

    #[test]
    fn iso_and_day() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_795_374_532_596), "2026-11-22T19:08:52Z");
        assert_eq!(day(1_795_374_532_596), "2026-11-22");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn route_classes_never_carry_ids() {
        assert_eq!(route_class("/api/session/ses_abc/messages?x=1"), "api.session.messages");
        assert_eq!(route_class("/api/pair/refresh"), "api.pair.refresh");
        assert_eq!(route_class("/rtc/v1?access_token=secret"), "rtc");
        assert_eq!(route_class("/"), "page");
        assert_eq!(route_class("/_next/static/x.js"), "static");
        assert_eq!(route_class("/_probe"), "probe");
    }

    #[test]
    fn sweep_deletes_only_old_dated_files() {
        let d = std::env::temp_dir().join(format!("meter-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let old = d.join("bridge-min-2001-01-01.jsonl");
        let new = d.join(format!("bridge-min-{}.jsonl", day(now_ms())));
        let other = d.join("notes.txt");
        for f in [&old, &new, &other] {
            std::fs::write(f, "x").unwrap();
        }
        sweep(&d);
        assert!(!old.exists() && new.exists() && other.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dir_beside_state() {
        let d = dir_beside(std::path::Path::new("/h/hub/state/devices.json")).unwrap();
        assert_eq!(d, PathBuf::from("/h/hub/state/../obs"));
    }
}
