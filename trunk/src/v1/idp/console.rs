//! `trunk-ctl` commands (spec §7 "Console"), run inside the trunk for the socket's peer (root =
//! the console = the admin's last resort). M1: claim, account, unlock, audit, backup, state.

use serde_json::json;

use super::audit::Entry;
use super::{account, audit, claim};
use crate::v1::crypto::{b64u, random_bytes};
use crate::v1::db::now_ms;
use crate::v1::server::State;
use std::sync::Arc;

pub const USAGE: &str = "usage: trunk-ctl [--sock PATH | -c trunk.toml] <command>
  state                                the trunk's state (json)
  claim-code [--json]                  the live claim code (read by the on-device agent)
  claim-link                           a claim link made by the console (no code needed)
  claim-reset                          after 5 wrong codes: zero the count, unlock, new code
  account list                         the account(s), 2FA state, devices
  account reset-2fa [EMAIL]            drop the authenticator + recovery codes (next sign-in enrols anew)
  account reset-password [EMAIL]       set a random password, printed once here
  account unlock [EMAIL]               clear the password and 2FA lockouts
  unlock                               lift a kill-switch lockdown
  audit tail [N]                       the last N audit entries (json lines)
  roots list                           the roots of this trunk (id, name, keys, online, rebind)
  roots revoke ID [WHY..]              cut a root: link closed, key refused, directory pushed
  import-v0 --roots roots.json [--dtls bridge-dtls.json | --hub-dtls-fp PIN] --hub-name NAME
          --hub-wg-pub PUB --hub-root-pub PUB                bring the v0.9 trunk's roots in (§11)
  audit verify                         recompute the audit hash chain
  backup [DIR]                         an encrypted copy of trunk.db (default <state_dir>/backups)
  backup check FILE                    decrypt a backup in memory and check it";

pub async fn run(st: &Arc<State>, args: &[String]) -> (bool, String) {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let r: Result<String, String> = match a.as_slice() {
        ["state"] => Ok(String::from_utf8_lossy(&super::api::state(st).body).into_owned()),
        ["claim-code"] => claim::current(st).map(|v| {
            format!("{}  (new code in {}:{:02}; {} wrong tries left)", v["display"].as_str().unwrap_or(""), v["expires_in"].as_i64().unwrap_or(0) / 60, v["expires_in"].as_i64().unwrap_or(0) % 60, v["attempts_left"])
        }),
        ["claim-code", "--json"] => claim::current(st).map(|v| v.to_string()),
        ["claim-link"] => claim::link(st),
        ["claim-reset"] => claim::reset(st),
        ["account", "list"] => Ok(account::list(st).iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")),
        ["account", "reset-2fa", rest @ ..] => account::console_reset_2fa(st, rest.first().copied()),
        ["account", "reset-password", rest @ ..] => account::console_reset_password(st, rest.first().copied()).await,
        ["account", "unlock", rest @ ..] => account::console_unlock(st, rest.first().copied()),
        ["unlock"] => {
            let was = st.lockdown();
            let _ = st.db.meta_set("lockdown", "0");
            super::audit(st, Entry::new("lockdown.off").detail(json!({ "via": "console", "was": was })));
            Ok(if was { "lockdown lifted: sign-in works again".into() } else { "no lockdown was on".into() })
        }
        ["audit", "tail"] => Ok(audit::tail(&st.db, 20).iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")),
        ["audit", "tail", n] => match n.parse::<i64>() {
            Ok(n) if n > 0 => Ok(audit::tail(&st.db, n.min(10_000)).iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")),
            _ => Err("audit tail N: N is a positive number".into()),
        },
        ["audit", "verify"] => match audit::verify(&st.db) {
            Ok((n, head)) => Ok(format!("audit chain ok: {n} entries, head {head}")),
            Err((seq, why)) => Err(format!("AUDIT CHAIN BROKEN at entry {seq}: {why}")),
        },
        ["roots", "list"] => crate::v1::import::roots_list(st),
        ["roots", "revoke", id] => crate::v1::import::roots_revoke(st, id, "removed by the console"),
        ["roots", "revoke", id, rest @ ..] => crate::v1::import::roots_revoke(st, id, &rest.join(" ")),
        ["import-v0", rest @ ..] => { let args: Vec<String> = rest.iter().map(|s| s.to_string()).collect(); crate::v1::import::import_v0(st, &args) },
        ["backup"] => backup(st, None),
        ["backup", "check", f] => backup_check(st, f),
        ["backup", dir] => backup(st, Some(dir)),
        ["help"] | [] => Ok(USAGE.into()),
        _ => Err(format!("unknown command: {}\n{USAGE}", args.join(" "))),
    };
    match r {
        Ok(s) => (true, s),
        Err(e) => (false, e),
    }
}

const BACKUP_MAGIC: &[u8; 8] = b"YGGTBK1\0";

/// `VACUUM INTO` a consistent copy, sealed under a kek-derived key (`YGGTBK1\0` ‖ nonce ‖ ct ‖ tag),
/// written 0600. The kek must be kept separately: without it the backup (and the db's own *_enc
/// columns) cannot be opened.
fn backup(st: &State, dir: Option<&str>) -> Result<String, String> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let dir = dir.map(str::to_string).unwrap_or_else(|| format!("{}/backups", st.cfg.state_dir.trim_end_matches('/')));
    if !std::path::Path::new(&dir).exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{dir}: {e}"))?;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let tmp = format!("{dir}/.snap-{}.db", b64u(&random_bytes::<6>()));
    st.db.snapshot_to(&tmp)?;
    let plain = std::fs::read(&tmp).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&tmp);
    let plain = plain?;
    let ts = crate::v1::paseto::fmt_time(now_ms() / 1000).replace([':', '-'], "");
    let out = format!("{dir}/trunk-{ts}.db.enc");
    let mut blob = BACKUP_MAGIC.to_vec();
    blob.extend(st.kek.derive("backup").seal("trunk-backup-v1", &plain));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&out).map_err(|e| format!("{out}: {e}"))?;
    f.write_all(&blob).map_err(|e| e.to_string())?;
    super::audit(st, Entry::new("backup").detail(json!({ "bytes": blob.len() })));
    Ok(format!("{out}  ({} bytes, sealed under trunk-kek)", blob.len()))
}

fn backup_check(st: &State, file: &str) -> Result<String, String> {
    let blob = std::fs::read(file).map_err(|e| format!("{file}: {e}"))?;
    let body = blob.strip_prefix(BACKUP_MAGIC.as_slice()).ok_or("not a trunk backup")?;
    let plain = st.kek.derive("backup").open("trunk-backup-v1", body)?;
    if !plain.starts_with(b"SQLite format 3\0") {
        return Err("decrypted, but not a SQLite database".into());
    }
    Ok(format!("backup ok: {} bytes of SQLite inside", plain.len()))
}
