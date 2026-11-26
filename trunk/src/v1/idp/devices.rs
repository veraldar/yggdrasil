//! Devices, revoke, kill-switch and console root management (spec §4.1 items 8–9, §5.4, §7, §8).
//!
//! Roles (§8):
//!   - admin: sees all devices, renames/revokes any device, changes roles (fresh step-up; a device
//!     can be admin ONLY if the admin's own 2FA or passkey happened on that device), pulls kill-switch.
//!   - member: sees, renames, and signs out/revokes ONLY itself.

use std::net::IpAddr;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::audit::Entry;
use super::session::{self, Who};
use crate::v1::db::now_ms;
use crate::v1::http::Resp;
use crate::v1::relay;
use crate::v1::server::State;

pub fn clean_device_name(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > 40 || t.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(t.to_string())
}

fn device_row_json(r: &rusqlite::Row<'_>, self_id: &str) -> rusqlite::Result<Value> {
    let id: String = r.get(0)?;
    let last_2fa_at: Option<i64> = r.get(9)?;
    Ok(json!({
        "id": id,
        "name": r.get::<_, String>(1)?,
        "role": r.get::<_, String>(2)?,
        "created_via": r.get::<_, String>(3)?,
        "created_at": r.get::<_, i64>(4)?,
        "last_seen": r.get::<_, i64>(5)?,
        "first_region": r.get::<_, String>(6)?,
        "last_region": r.get::<_, String>(7)?,
        "moved_count": r.get::<_, i64>(8)?,
        "last_2fa_at": last_2fa_at,
        "door_root": r.get::<_, Option<String>>(10)?,
        "ua_family": r.get::<_, Option<String>>(11)?,
        "revoked_at": r.get::<_, Option<i64>>(12)?,
        "revoked_by": r.get::<_, Option<String>>(13)?,
        "revoked_why": r.get::<_, Option<String>>(14)?,
        "current": id == self_id,
        "can_be_admin": last_2fa_at.is_some(),
    }))
}

const DEV_COLS: &str = "id, name, role, created_via, created_at, last_seen, first_region, last_region, moved_count, last_2fa_at, door_root, ua_family, revoked_at, revoked_by, revoked_why";

/// GET /t/devices — admin sees all devices of the account (active + revoked); member sees only self.
pub fn list(st: &State, who: &Who) -> Resp {
    let is_admin = who.role == "admin";
    let devices: Vec<Value> = st
        .db
        .with(|c| {
            if is_admin {
                let mut s = c.prepare(&format!(
                    "SELECT {DEV_COLS} FROM devices WHERE account_id = ?1 ORDER BY (revoked_at IS NOT NULL), last_seen DESC, created_at DESC"
                ))?;
                let v = s.query_map([&who.account], |r| device_row_json(r, &who.did))?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            } else {
                let mut s = c.prepare(&format!("SELECT {DEV_COLS} FROM devices WHERE id = ?1"))?;
                let v = s.query_map([&who.did], |r| device_row_json(r, &who.did))?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            }
        })
        .unwrap_or_default();
    Resp::json(
        200,
        &json!({
            "devices": devices,
            "self_id": who.did,
            "role": who.role,
            "kill_epoch": st.kill_epoch(),
            "lockdown": st.lockdown(),
            "fresh": who.fresh(st),
            "fresh_until": who.fresh_until(st),
        }),
    )
}

/// PATCH /t/devices/:id `{name?, role?}` — rename (admin: any, member: self only) / role (admin + fresh).
pub fn patch(st: &State, who: &Who, id: &str, name: Option<&str>, role: Option<&str>, ip: IpAddr) -> Resp {
    let is_admin = who.role == "admin";
    if !is_admin && id != who.did {
        return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
    }
    if role.is_some() {
        if !is_admin {
            return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
        }
        if !who.fresh(st) {
            return session::step_up_needed();
        }
    }
    if name.is_none() && role.is_none() {
        return Resp::json(400, &json!({ "error": "nothing to change" }));
    }
    let existing: Option<(String, String, Option<i64>, Option<i64>)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT name, role, last_2fa_at, revoked_at FROM devices WHERE id = ?1 AND account_id = ?2",
                params![id, who.account],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((old_name, old_role, last_2fa_at, revoked_at)) = existing else {
        return Resp::json(404, &json!({ "error": "no such device" }));
    };
    if revoked_at.is_some() {
        return Resp::json(409, &json!({ "error": "that device is already revoked" }));
    }
    let new_name = match name {
        Some(n) => match clean_device_name(n) {
            Some(c) => Some(c),
            None => return Resp::json(400, &json!({ "error": "name must be 1–40 characters" })),
        },
        None => None,
    };
    let new_role = match role {
        Some("admin") => {
            // §8 Roles: a device is admin only if the admin's own 2FA or passkey happened on that device
            if last_2fa_at.is_none() {
                return Resp::json(
                    403,
                    &json!({ "error": "a device can be admin only if 2FA or a passkey happened on it", "why": "no-2fa-on-device" }),
                );
            }
            Some("admin")
        }
        Some("member") => Some("member"),
        Some(_) => return Resp::json(400, &json!({ "error": "role must be admin or member" })),
        None => None,
    };
    if let Some(ref nn) = new_name {
        if let Err(e) = st.db.with(|c| c.execute("UPDATE devices SET name = ?1 WHERE id = ?2", params![nn, id]).map(|_| ())) {
            return Resp::json(500, &json!({ "error": e }));
        }
        if nn != &old_name {
            super::audit(
                st,
                Entry::new("device.rename")
                    .account(&who.account)
                    .device(&who.did)
                    .ip(ip)
                    .target("device", id)
                    .detail(json!({ "from": old_name, "to": nn })),
            );
        }
    }
    if let Some(nr) = new_role {
        if let Err(e) = st.db.with(|c| c.execute("UPDATE devices SET role = ?1 WHERE id = ?2", params![nr, id]).map(|_| ())) {
            return Resp::json(500, &json!({ "error": e }));
        }
        if nr != old_role {
            super::audit(
                st,
                Entry::new("device.role")
                    .account(&who.account)
                    .device(&who.did)
                    .ip(ip)
                    .target("device", id)
                    .detail(json!({ "from": old_role, "to": nr })),
            );
        }
    }
    let updated: Option<Value> = st
        .db
        .with(|c| c.query_row(&format!("SELECT {DEV_COLS} FROM devices WHERE id = ?1"), [id], |r| device_row_json(r, &who.did)).optional())
        .ok()
        .flatten();
    Resp::json(200, &json!({ "ok": true, "device": updated }))
}

/// DELETE /t/devices/:id — admin revokes any device; member revokes only itself.
pub fn revoke(st: &Arc<State>, who: &Who, id: &str, ip: IpAddr) -> Resp {
    let is_admin = who.role == "admin";
    if !is_admin && id != who.did {
        return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
    }
    let exists: Option<(Option<i64>, String)> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT revoked_at, name FROM devices WHERE id = ?1 AND account_id = ?2",
                params![id, who.account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let Some((revoked_at, _name)) = exists else {
        return Resp::json(404, &json!({ "error": "no such device" }));
    };
    if revoked_at.is_some() {
        return Resp::json(200, &json!({ "ok": true, "revoked": id, "already": true }));
    }
    let why = if id == who.did { "signed out" } else { "revoked by admin" };
    session::revoke_device(st, id, Some(&who.did), why, Some(ip));
    relay::device_revoked(st, id, (now_ms() + 900_000) as u64);
    let r = Resp::json(200, &json!({ "ok": true, "revoked": id, "self": id == who.did }));
    if id == who.did { session::clear_cookies(r) } else { r }
}

/// Kill-switch (§5.4): revoke every device, burn every refresh token, QR and pending enrollment,
/// bump kill_epoch by 1, optionally enable lockdown, push signed `kill` to every root.
pub fn kill_all(
    st: &Arc<State>,
    by_account: Option<&str>,
    by_device: Option<&str>,
    lockdown: bool,
    ip: Option<IpAddr>,
    via: &str,
) -> Result<(u64, usize, usize, usize), String> {
    let now = now_ms();
    let has_enrollments = st.db.table_exists("enrollments");
    let (epoch, devs, pairs, enrs) = st.db.with(|c| {
        let tx = c.transaction()?;
        let devs = tx.execute(
            "UPDATE devices SET revoked_at = ?1, revoked_by = ?2, revoked_why = 'kill-switch' WHERE revoked_at IS NULL",
            params![now, by_device],
        )?;
        tx.execute("UPDATE refresh_tokens SET retired_at = ?1 WHERE retired_at IS NULL", [now])?;
        let pairs = tx.execute(
            "UPDATE pair_tokens SET burned_at = ?1, burn_why = 'kill-switch' WHERE consumed_at IS NULL AND burned_at IS NULL",
            [now],
        )?;
        let enrs = if has_enrollments {
            tx.execute("UPDATE enrollments SET status = 'refused' WHERE status = 'pending'", [])?
        } else {
            0
        };
        let old_epoch: u64 = tx
            .query_row("SELECT v FROM meta WHERE k = 'kill_epoch'", [], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let new_epoch = old_epoch + 1;
        tx.execute(
            "INSERT INTO meta (k, v) VALUES ('kill_epoch', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [new_epoch.to_string()],
        )?;
        if lockdown {
            tx.execute(
                "INSERT INTO meta (k, v) VALUES ('lockdown', '1') ON CONFLICT(k) DO UPDATE SET v = '1'",
                [],
            )?;
        }
        tx.commit()?;
        Ok((new_epoch, devs, pairs, enrs))
    })?;
    st.idp.mfa.lock().unwrap_or_else(|e| e.into_inner()).clear();
    st.idp.totp_pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
    relay::killed(st, epoch, st.lockdown());
    let mut e = Entry::new("kill.switch").detail(json!({
        "epoch": epoch, "lockdown": lockdown, "devices_revoked": devs, "pairs_burned": pairs, "enrollments_burned": enrs, "via": via,
    }));
    if let Some(a) = by_account {
        e = e.account(a);
    }
    if let Some(d) = by_device {
        e = e.device(d);
    }
    if let Some(ip) = ip {
        e = e.ip(ip);
    }
    super::audit(st, e);
    Ok((epoch, devs, pairs, enrs))
}

/// POST /t/kill `{lockdown?}` — admin only.
pub fn kill_http(st: &Arc<State>, who: &Who, lockdown: bool, ip: IpAddr) -> Resp {
    if who.role != "admin" {
        return Resp::json(403, &json!({ "error": "admin only", "why": "role" }));
    }
    match kill_all(st, Some(&who.account), Some(&who.did), lockdown, Some(ip), "api") {
        Ok((epoch, devs, pairs, enrs)) => session::clear_cookies(Resp::json(
            200,
            &json!({
                "ok": true, "kill_epoch": epoch, "lockdown": st.lockdown(),
                "devices_revoked": devs, "pairs_burned": pairs, "enrollments_burned": enrs,
            }),
        )),
        Err(e) => Resp::json(500, &json!({ "error": e })),
    }
}

// ---- console (`trunk-ctl devices …`, `trunk-ctl roots …`) ------------------------------------

pub fn console_list(st: &State) -> Vec<Value> {
    st.db
        .with(|c| {
            let mut s = c.prepare(&format!("SELECT {DEV_COLS} FROM devices ORDER BY (revoked_at IS NOT NULL), last_seen DESC"))?;
            let v = s.query_map([], |r| device_row_json(r, ""))?.collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default()
}

pub fn console_revoke(st: &Arc<State>, id: &str, why: Option<&str>) -> Result<String, String> {
    let why = why.unwrap_or("revoked from console");
    if !session::revoke_device(st, id, Some("console"), why, None) {
        return Err(format!("no active device {id}"));
    }
    relay::device_revoked(st, id, (now_ms() + 900_000) as u64);
    Ok(format!("device {id} revoked ({why})"))
}

pub fn console_roots_list(st: &Arc<State>) -> Vec<Value> {
    if !st.db.table_exists("roots") {
        return vec![];
    }
    let hub = relay::hub(st);
    let rows: Vec<Value> = st
        .db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT id, name, hostname, os, arch, version, wg_addr, has_app, has_voice, enrolled_at, last_seen, revoked_at, revoked_why
                 FROM roots ORDER BY (revoked_at IS NOT NULL), enrolled_at, id",
            )?;
            let v = s
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "hostname": r.get::<_, String>(2)?,
                        "os": r.get::<_, String>(3)?, "arch": r.get::<_, String>(4)?, "version": r.get::<_, String>(5)?,
                        "wg_addr": r.get::<_, String>(6)?, "has_app": r.get::<_, i64>(7)? != 0, "has_voice": r.get::<_, i64>(8)? != 0,
                        "enrolled_at": r.get::<_, i64>(9)?, "last_seen": r.get::<_, Option<i64>>(10)?,
                        "revoked_at": r.get::<_, Option<i64>>(11)?, "revoked_why": r.get::<_, Option<String>>(12)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    rows.into_iter()
        .map(|mut r| {
            let id = r["id"].as_str().unwrap_or_default().to_string();
            r["online"] = json!(hub.online(&id));
            r
        })
        .collect()
}

pub fn console_roots_revoke(st: &Arc<State>, id: &str, why: Option<&str>) -> Result<String, String> {
    if !st.db.table_exists("roots") {
        return Err("no roots enrolled".into());
    }
    let why = why.unwrap_or("revoked from console");
    let n = st
        .db
        .with(|c| {
            c.execute(
                "UPDATE roots SET revoked_at = ?1, revoked_by = 'console', revoked_why = ?2 WHERE id = ?3 AND revoked_at IS NULL",
                params![now_ms(), why, id],
            )
        })
        .unwrap_or(0);
    if n == 0 {
        return Err(format!("no active root {id}"));
    }
    let _ = st.db.with(|c| c.execute("UPDATE devices SET door_root = NULL WHERE door_root = ?1", [id]));
    super::audit(st, Entry::new("root.revoke").target("root", id).detail(json!({ "why": why, "via": "console" })));
    relay::hub(st).root_revoked(id);
    Ok(format!("root {id} revoked ({why})"))
}
