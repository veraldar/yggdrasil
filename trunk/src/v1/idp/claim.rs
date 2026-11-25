//! F1 · Claim (spec §5.6): a rotating 6-digit code (300 s; the previous one stays valid ≤15 s),
//! held only in `<cred_dir>/claim` (0600) and as a peppered hash in the db. The agent reads it
//! (`trunk-ctl claim-code --json`), `POST /t/claim/begin {code}` → a ticket (32 B, 10 min) →
//! `/claim#t=<ticket>` → approve → signup → TOTP confirm → claimed: `/claim` answers 410 and the
//! rotation stops for good. 5 wrong codes in total, across rotations → locked until
//! `trunk-ctl claim-reset`.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::json;

use super::audit::Entry;
use super::limits::{self, Kind};
use crate::v1::crypto::{b64u, ct_eq, random_below, random_bytes, sha256_hex};
use crate::v1::db::now_ms;
use crate::v1::server::State;

pub const MAX_WRONG: i64 = 5;

#[derive(Default, Debug)]
pub struct Runtime {
    pub code: Option<String>,
    pub rotated_at: i64,
    /// the previous code and until when it still counts
    pub prev: Option<(String, i64)>,
    /// the digits the live ticket was begun with (display on /claim), and who began it
    pub ticket_code: Option<String>,
    pub ticket_via: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Err {
    Gone,
    Locked,
    TooMany(i64),
    Wrong(i64),
    BadTicket,
    State(&'static str),
}

impl Err {
    pub fn resp(&self) -> crate::v1::http::Resp {
        use crate::v1::http::Resp;
        match self {
            Err::Gone => Resp::json(410, &json!({ "error": "this trunk is claimed", "why": "claimed" })),
            Err::Locked => Resp::json(423, &json!({ "error": "the claim is locked after 5 wrong codes — run `sudo trunk-ctl claim-reset` on the server", "why": "locked" })),
            Err::TooMany(s) => Resp::json(429, &json!({ "error": "too many attempts from this network", "retry_after": s })).header("Retry-After", &s.to_string()),
            Err::Wrong(left) => Resp::json(401, &json!({ "error": "wrong code", "why": "wrong", "left": left })),
            Err::BadTicket => Resp::json(401, &json!({ "error": "this claim link is not valid (expired or used) — ask your agent for a new one", "why": "ticket" })),
            Err::State(s) => Resp::json(409, &json!({ "error": s, "why": "state" })),
        }
    }
}

pub fn display(code: &str) -> String {
    format!("{}-{}", &code[..3], &code[3..])
}

fn file_path(st: &State) -> String {
    format!("{}/claim", st.cfg.cred_dir.trim_end_matches('/'))
}

fn write_file(st: &State, code: &str, rotated_at: i64) {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let p = file_path(st);
    let tmp = format!("{p}.tmp");
    let body = json!({ "code": code, "rotated_at": rotated_at, "expires_at": rotated_at + st.idp.t.claim_rotate_ms }).to_string() + "\n";
    let _ = std::fs::remove_file(&tmp);
    let ok = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(body.as_bytes()))
        .and_then(|_| std::fs::rename(&tmp, &p));
    if let Err(e) = ok {
        eprintln!("  trunk: claim file {p}: {e}");
    }
}

fn remove_file(st: &State) {
    let _ = std::fs::remove_file(file_path(st));
}

fn locked(st: &State) -> bool {
    st.db.with(|c| c.query_row("SELECT locked FROM claim WHERE id = 1", [], |r| r.get::<_, i64>(0))).unwrap_or(1) != 0
}

pub fn attempts(st: &State) -> i64 {
    st.db.with(|c| c.query_row("SELECT attempts_total FROM claim WHERE id = 1", [], |r| r.get::<_, i64>(0))).unwrap_or(0)
}

/// A fresh code (the old one counts for `claim_overlap_ms` more).
pub fn rotate(st: &State, now: i64) {
    let code = format!("{:06}", random_below(1_000_000));
    let hash = st.kek.pepper("claim", code.as_bytes());
    let mut rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = rt.code.take() {
        rt.prev = Some((old, now + st.idp.t.claim_overlap_ms));
    }
    rt.code = Some(code.clone());
    rt.rotated_at = now;
    drop(rt);
    let _ = st.db.with(|c| c.execute("UPDATE claim SET code_hash = ?1, rotated_at = ?2 WHERE id = 1", params![hash, now]));
    write_file(st, &code, now);
}

pub fn start(st: &State) {
    if st.claimed() {
        remove_file(st);
    } else {
        rotate(st, now_ms());
        st.idp.claim.lock().unwrap_or_else(|e| e.into_inner()).prev = None;
    }
}

pub fn tick(st: &State, now: i64) {
    if st.claimed() {
        let had = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner()).code.take().is_some();
        if had {
            remove_file(st);
        }
        return;
    }
    let due = {
        let rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
        now - rt.rotated_at >= st.idp.t.claim_rotate_ms
    };
    if due {
        rotate(st, now);
    }
}

/// `trunk-ctl claim-code --json`
pub fn current(st: &State) -> Result<serde_json::Value, String> {
    if st.claimed() {
        return Err("this trunk is claimed — there is no claim code any more".into());
    }
    if locked(st) {
        return Err("the claim is locked after 5 wrong codes — run `trunk-ctl claim-reset`".into());
    }
    let rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
    let code = rt.code.clone().ok_or("no claim code yet")?;
    let left = (rt.rotated_at + st.idp.t.claim_rotate_ms - now_ms()).max(0) / 1000;
    Ok(json!({
        "code": code, "display": display(&code), "expires_in": left, "rotated_at": rt.rotated_at,
        "url": st.cfg.origin(), "begin": format!("{}/t/claim/begin", st.cfg.origin()),
        "attempts_left": MAX_WRONG - attempts(st),
    }))
}

fn new_ticket(st: &State, now: i64, via: &'static str, code: Option<String>) -> String {
    let ticket = b64u(&random_bytes::<32>());
    let _ = st.db.with(|c| {
        c.execute(
            "UPDATE claim SET ticket_hash = ?1, ticket_expires = ?2, ticket_state = 'begun' WHERE id = 1",
            params![sha256_hex(ticket.as_bytes()), now + st.idp.t.claim_ticket_ms],
        )
    });
    let mut rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
    rt.ticket_code = code;
    rt.ticket_via = Some(via);
    ticket
}

/// POST /t/claim/begin {code}
pub fn begin(st: &State, code: &str, ip: IpAddr) -> Result<(String, i64), Err> {
    let now = now_ms();
    if st.claimed() {
        return Err(Err::Gone);
    }
    if locked(st) {
        return Err(Err::Locked);
    }
    let nk = limits::net_key(ip);
    if let Some(s) = limits::locked(&st.db, &nk, now) {
        return Err(Err::TooMany(s));
    }
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    let ok = {
        let rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
        let cur = rt.code.as_deref().is_some_and(|c| code.len() == 6 && ct_eq(c.as_bytes(), code.as_bytes()));
        let prev = rt.prev.as_ref().is_some_and(|(c, until)| *until > now && code.len() == 6 && ct_eq(c.as_bytes(), code.as_bytes()));
        cur || prev
    };
    if !ok {
        let total = st
            .db
            .with(|c| {
                c.execute("UPDATE claim SET attempts_total = attempts_total + 1 WHERE id = 1", [])?;
                c.execute("UPDATE claim SET locked = 1 WHERE id = 1 AND attempts_total >= ?1", [MAX_WRONG])?;
                c.query_row("SELECT attempts_total FROM claim WHERE id = 1", [], |r| r.get::<_, i64>(0))
            })
            .unwrap_or(MAX_WRONG);
        limits::fail(&st.db, &nk, Kind::Net, &st.idp.t, now);
        super::audit(st, Entry::new("claim.wrong_code").ip(ip).detail(json!({ "attempts_total": total })));
        if total >= MAX_WRONG {
            super::audit(st, Entry::new("claim.locked").ip(ip).detail(json!({ "attempts_total": total })));
            return Err(Err::Locked);
        }
        return Err(Err::Wrong(MAX_WRONG - total));
    }
    let ticket = new_ticket(st, now, "agent", Some(code));
    // single use: the code that began this claim is spent
    rotate(st, now);
    st.idp.claim.lock().unwrap_or_else(|e| e.into_inner()).prev = None;
    super::audit(st, Entry::new("claim.begin").ip(ip));
    Ok((ticket, st.idp.t.claim_ticket_ms / 1000))
}

/// `trunk-ctl claim-link`: a ticket made by the console itself (no code needed).
pub fn link(st: &State) -> Result<String, String> {
    if st.claimed() {
        return Err("this trunk is claimed".into());
    }
    let t = new_ticket(st, now_ms(), "console", None);
    super::audit(st, Entry::new("claim.link").detail(json!({ "via": "console" })));
    Ok(format!("{}/claim#t={t}", st.cfg.origin()))
}

/// The live ticket's state when `ticket` is it ("begun" | "approved").
pub fn check_ticket(st: &State, ticket: &str) -> Result<String, Err> {
    if st.claimed() {
        return Err(Err::Gone);
    }
    let row: Option<(Option<String>, Option<i64>, Option<String>)> = st
        .db
        .with(|c| c.query_row("SELECT ticket_hash, ticket_expires, ticket_state FROM claim WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())
        .ok()
        .flatten();
    let Some((Some(h), Some(exp), Some(state))) = row else { return Err(Err::BadTicket) };
    if ticket.is_empty() || !ct_eq(sha256_hex(ticket.as_bytes()).as_bytes(), h.as_bytes()) || exp <= now_ms() {
        return Err(Err::BadTicket);
    }
    Ok(state)
}

/// POST /t/claim/ticket {ticket} — what the /claim page shows (the digits are display only).
pub fn info(st: &State, ticket: &str) -> Result<serde_json::Value, Err> {
    let state = check_ticket(st, ticket)?;
    let rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
    let pending_account = st
        .db
        .with(|c| c.query_row("SELECT email FROM accounts LIMIT 1", [], |r| r.get::<_, Option<String>>(0)).optional())
        .ok()
        .flatten()
        .flatten();
    let exp: i64 = st.db.with(|c| c.query_row("SELECT ticket_expires FROM claim WHERE id = 1", [], |r| r.get(0))).unwrap_or(0);
    Ok(json!({
        "state": state,
        "code": rt.ticket_code.as_deref().map(display),
        "via": rt.ticket_via.unwrap_or("agent"),
        "host": st.cfg.host(),
        "expires_in": (exp - now_ms()).max(0) / 1000,
        "pending_email": pending_account,
        "providers": st.cfg.oauth.keys().collect::<Vec<_>>(),
    }))
}

/// POST /t/claim/approve {ticket}
pub fn approve(st: &State, ticket: &str, ip: IpAddr) -> Result<(), Err> {
    check_ticket(st, ticket)?;
    let _ = st.db.with(|c| c.execute("UPDATE claim SET ticket_state = 'approved' WHERE id = 1", []));
    super::audit(st, Entry::new("claim.approve").ip(ip));
    Ok(())
}

/// POST /t/claim/refuse {ticket}: the ticket dies and the code rotates now.
pub fn refuse(st: &State, ticket: &str, ip: IpAddr) -> Result<(), Err> {
    check_ticket(st, ticket)?;
    clear_ticket(st);
    // a half-made admin (signup without TOTP) goes with it
    let _ = st.db.with(|c| {
        c.execute("DELETE FROM totp", [])?;
        c.execute("DELETE FROM recovery_codes", [])?;
        c.execute("DELETE FROM accounts WHERE NOT EXISTS (SELECT 1 FROM devices)", [])
    });
    rotate(st, now_ms());
    super::audit(st, Entry::new("claim.refuse").ip(ip));
    Ok(())
}

fn clear_ticket(st: &State) {
    let _ = st.db.with(|c| c.execute("UPDATE claim SET ticket_hash = NULL, ticket_expires = NULL, ticket_state = NULL WHERE id = 1", []));
    let mut rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
    rt.ticket_code = None;
    rt.ticket_via = None;
}

/// `trunk-ctl claim-reset`: the count goes back to zero, the lock opens, any ticket dies, a new code.
pub fn reset(st: &State) -> Result<String, String> {
    if st.claimed() {
        return Err("this trunk is claimed — nothing to reset".into());
    }
    let before = attempts(st);
    st.db.with(|c| c.execute("UPDATE claim SET attempts_total = 0, locked = 0 WHERE id = 1", []))?;
    clear_ticket(st);
    rotate(st, now_ms());
    st.idp.claim.lock().unwrap_or_else(|e| e.into_inner()).prev = None;
    super::audit(st, Entry::new("claim.reset").detail(json!({ "attempts_before": before })));
    Ok(format!("claim reset (wrong codes before: {before}); a new code is live"))
}

/// The admin's TOTP is confirmed: the trunk is claimed, for good.
pub fn complete(st: &State, account: &str, device: &str, ip: IpAddr) {
    let now = now_ms();
    let _ = st.db.meta_set("claimed_at", &now.to_string());
    let _ = st.db.with(|c| c.execute("UPDATE claim SET code_hash = NULL, ticket_hash = NULL, ticket_expires = NULL, ticket_state = NULL WHERE id = 1", []));
    {
        let mut rt = st.idp.claim.lock().unwrap_or_else(|e| e.into_inner());
        *rt = Runtime::default();
    }
    remove_file(st);
    super::audit(st, Entry::new("claim.complete").account(account).device(device).ip(ip).target("account", account));
}
