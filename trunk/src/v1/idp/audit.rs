//! The audit log (spec §6, §8): every auth, device, root, QR, claim, kill and lockout event, in a
//! hash chain (`hash = sha256(prev_hash ‖ "\n" ‖ canonical row)`), mirrored to a daily JSONL file
//! (0600) and kept 400 days. Addresses are truncated to /24 or /48. Never a secret.

use std::io::Write as _;
use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::v1::crypto::sha256_hex;
use crate::v1::db::{now_ms, Db};
use crate::v1::paseto::fmt_time;

pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
pub const KEEP_DAYS: i64 = 400;

#[derive(Default, Clone)]
pub struct Entry {
    pub actor_account: Option<String>,
    pub actor_device: Option<String>,
    pub actor_root: Option<String>,
    pub action: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub ip: Option<IpAddr>,
    pub detail: Value,
}

impl Entry {
    pub fn new(action: &str) -> Entry {
        Entry { action: action.into(), detail: json!({}), ..Default::default() }
    }
    pub fn ip(mut self, ip: IpAddr) -> Entry {
        self.ip = Some(ip);
        self
    }
    pub fn account(mut self, a: &str) -> Entry {
        self.actor_account = Some(a.into());
        self
    }
    pub fn device(mut self, d: &str) -> Entry {
        self.actor_device = Some(d.into());
        self
    }
    pub fn root(mut self, r: &str) -> Entry {
        self.actor_root = Some(r.into());
        self
    }
    pub fn target(mut self, kind: &str, id: &str) -> Entry {
        self.target_kind = Some(kind.into());
        self.target_id = Some(id.into());
        self
    }
    pub fn detail(mut self, d: Value) -> Entry {
        self.detail = d;
        self
    }
}

fn canonical(seq: i64, ts: i64, r: &[Option<String>; 8], detail: &str) -> String {
    json!([seq, ts, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], detail]).to_string()
}

pub fn chain_hash(prev: &str, canonical: &str) -> String {
    sha256_hex(format!("{prev}\n{canonical}").as_bytes())
}

/// Append one entry; returns its row as JSON (what the mirror gets).
pub fn append(db: &Db, mirror_dir: Option<&str>, e: Entry) -> Result<Value, String> {
    let ts = now_ms();
    let region = e.ip.map(crate::region::region_of);
    let ip_trunc = e.ip.map(super::limits::net_of);
    let detail = e.detail.to_string();
    let row = db.with(|c| {
        let tx = c.transaction()?;
        let last: Option<(i64, String)> =
            tx.query_row("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let anchor: String = tx
            .query_row("SELECT v FROM meta WHERE k = 'audit_anchor'", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| GENESIS.to_string());
        let (seq, prev) = match last {
            Some((s, h)) => (s + 1, h),
            None => {
                let next: i64 = tx
                    .query_row("SELECT v FROM meta WHERE k = 'audit_next_seq'", [], |r| r.get::<_, String>(0))
                    .optional()?
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                (next, anchor)
            }
        };
        let f: [Option<String>; 8] = [
            e.actor_account.clone(), e.actor_device.clone(), e.actor_root.clone(), Some(e.action.clone()),
            e.target_kind.clone(), e.target_id.clone(), region.clone(), ip_trunc.clone(),
        ];
        let hash = chain_hash(&prev, &canonical(seq, ts, &f, &detail));
        tx.execute(
            "INSERT INTO audit (seq, ts, actor_account, actor_device, actor_root, action, target_kind, target_id, region, ip_trunc, detail_json, prev_hash, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![seq, ts, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], detail, prev, hash],
        )?;
        tx.commit()?;
        Ok(json!({
            "seq": seq, "ts": ts, "at": fmt_time(ts / 1000), "actor_account": f[0], "actor_device": f[1], "actor_root": f[2],
            "action": f[3], "target_kind": f[4], "target_id": f[5], "region": f[6], "ip": f[7],
            "detail": e.detail, "prev_hash": prev, "hash": hash,
        }))
    })?;
    if let Some(dir) = mirror_dir {
        let _ = mirror(dir, ts, &row);
    }
    Ok(row)
}

/// The daily JSONL mirror: `<dir>/audit-YYYY-MM-DD.jsonl`, 0600 (dir 0700).
fn mirror(dir: &str, ts: i64, row: &Value) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    if !std::path::Path::new(dir).exists() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let day = &fmt_time(ts / 1000)[..10];
    let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(format!("{dir}/audit-{day}.jsonl"))?;
    f.write_all(format!("{row}\n").as_bytes())
}

/// Recompute the whole chain. Ok((entries, head hash)) or Err((seq, why)).
pub fn verify(db: &Db) -> Result<(i64, String), (i64, String)> {
    let anchor = db.meta_get("audit_anchor").unwrap_or_else(|| GENESIS.to_string());
    let rows: Vec<(i64, i64, [Option<String>; 8], String, String, String)> = db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT seq, ts, actor_account, actor_device, actor_root, action, target_kind, target_id, region, ip_trunc, detail_json, prev_hash, hash FROM audit ORDER BY seq",
            )?;
            let v = s
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        [r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?],
                        r.get(10)?,
                        r.get(11)?,
                        r.get(12)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .map_err(|e| (0, e))?;
    let mut prev = anchor;
    let mut last_seq: Option<i64> = None;
    for (seq, ts, f, detail, prev_hash, hash) in &rows {
        if let Some(l) = last_seq {
            if *seq != l + 1 {
                return Err((*seq, format!("entry {} is missing", l + 1)));
            }
        }
        if *prev_hash != prev {
            return Err((*seq, "prev_hash does not match the entry before".into()));
        }
        if chain_hash(prev_hash, &canonical(*seq, *ts, f, detail)) != *hash {
            return Err((*seq, "content does not match its hash (changed after it was written)".into()));
        }
        prev = hash.clone();
        last_seq = Some(*seq);
    }
    Ok((rows.len() as i64, prev))
}

pub fn tail(db: &Db, n: i64) -> Vec<Value> {
    let mut v = db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT seq, ts, actor_account, actor_device, actor_root, action, target_kind, target_id, region, ip_trunc, detail_json, hash FROM audit ORDER BY seq DESC LIMIT ?1",
            )?;
            let v = s
                .query_map([n], |r| {
                    let ts: i64 = r.get(1)?;
                    let d: String = r.get(10)?;
                    Ok(json!({
                        "seq": r.get::<_, i64>(0)?, "at": fmt_time(ts / 1000), "actor_account": r.get::<_, Option<String>>(2)?,
                        "actor_device": r.get::<_, Option<String>>(3)?, "actor_root": r.get::<_, Option<String>>(4)?,
                        "action": r.get::<_, String>(5)?, "target_kind": r.get::<_, Option<String>>(6)?, "target_id": r.get::<_, Option<String>>(7)?,
                        "region": r.get::<_, Option<String>>(8)?, "ip": r.get::<_, Option<String>>(9)?,
                        "detail": serde_json::from_str::<Value>(&d).unwrap_or(Value::Null), "hash": r.get::<_, String>(11)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .unwrap_or_default();
    v.reverse();
    v
}

/// Drop entries older than 400 days; the chain then starts at the first kept entry's prev_hash.
pub fn retain(db: &Db, mirror_dir: Option<&str>, now: i64) -> usize {
    let cut = now - KEEP_DAYS * 86_400_000;
    let n = db
        .with(|c| {
            let tx = c.transaction()?;
            let next: Option<(i64, String)> =
                tx.query_row("SELECT seq, prev_hash FROM audit WHERE ts >= ?1 ORDER BY seq LIMIT 1", [cut], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let last: Option<(i64, String)> =
                tx.query_row("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let n = tx.execute("DELETE FROM audit WHERE ts < ?1", [cut])?;
            if n > 0 {
                let (anchor, next_seq) = match (next, last) {
                    (Some((_, p)), _) => (p, None),
                    (None, Some((s, h))) => (h, Some(s + 1)),
                    (None, None) => (GENESIS.to_string(), None),
                };
                tx.execute("INSERT INTO meta (k, v) VALUES ('audit_anchor', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [anchor])?;
                if let Some(s) = next_seq {
                    tx.execute("INSERT INTO meta (k, v) VALUES ('audit_next_seq', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [s.to_string()])?;
                }
            }
            tx.commit()?;
            Ok(n)
        })
        .unwrap_or(0);
    if let Some(dir) = mirror_dir {
        if let Ok(rd) = std::fs::read_dir(dir) {
            let oldest = format!("audit-{}.jsonl", &fmt_time(cut / 1000)[..10]);
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("audit-") && name.ends_with(".jsonl") && name < oldest {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(db: &Db, n: usize) {
        for i in 0..n {
            append(db, None, Entry::new("auth.login").account("acc_1").device(&format!("dev_{i}")).ip("203.0.113.9".parse().unwrap())).unwrap();
        }
    }

    #[test]
    fn chain_verifies_and_truncates_addresses() {
        let db = Db::memory();
        some(&db, 5);
        let (n, head) = verify(&db).unwrap();
        assert_eq!(n, 5);
        assert_eq!(head.len(), 64);
        let t = tail(&db, 2);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1]["seq"], 5);
        assert_eq!(t[0]["ip"], "203.0.113.0/24");
        assert_eq!(t[0]["region"], "net:203.0.0.0/16");
    }

    #[test]
    fn tamper_is_detected() {
        for how in ["detail", "action", "delete", "reorder", "rehash-one"] {
            let db = Db::memory();
            some(&db, 6);
            db.with(|c| {
                match how {
                    "detail" => c.execute("UPDATE audit SET detail_json = '{\"x\":1}' WHERE seq = 3", [])?,
                    "action" => c.execute("UPDATE audit SET action = 'nothing' WHERE seq = 4", [])?,
                    "delete" => c.execute("DELETE FROM audit WHERE seq = 2", [])?,
                    "reorder" => c.execute("UPDATE audit SET ts = ts + 1 WHERE seq = 5", [])?,
                    // an attacker recomputes one row's own hash: the next row's prev_hash still breaks
                    _ => {
                        let (ts, prev): (i64, String) = c.query_row("SELECT ts, prev_hash FROM audit WHERE seq = 3", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
                        let f: [Option<String>; 8] = [Some("acc_1".into()), Some("dev_evil".into()), None, Some("auth.login".into()), None, None, Some("net:203.0.0.0/16".into()), Some("203.0.113.0/24".into())];
                        let h = chain_hash(&prev, &canonical(3, ts, &f, "{}"));
                        c.execute("UPDATE audit SET actor_device = 'dev_evil', hash = ?1 WHERE seq = 3", [h])?
                    }
                };
                Ok(())
            })
            .unwrap();
            let e = verify(&db).unwrap_err();
            assert!(e.0 >= 2 && e.0 <= 5, "{how}: caught at {}", e.0);
        }
    }

    #[test]
    fn retention_keeps_the_chain_verifiable() {
        let db = Db::memory();
        some(&db, 4);
        db.with(|c| c.execute("UPDATE audit SET ts = 1000 WHERE seq <= 2", [])).unwrap();
        // the rewritten ts breaks those two rows; retention drops them, the rest still verifies
        assert_eq!(retain(&db, None, now_ms()), 2);
        let (n, _) = verify(&db).unwrap();
        assert_eq!(n, 2);
        some(&db, 1);
        assert_eq!(verify(&db).unwrap().0, 3);
        // everything old: the next entry still chains on
        db.with(|c| c.execute("UPDATE audit SET ts = 1000", [])).unwrap();
        retain(&db, None, now_ms());
        some(&db, 1);
        let t = tail(&db, 1);
        assert_eq!(t[0]["seq"], 6, "sequence numbers are never reused");
        assert_eq!(verify(&db).unwrap().0, 1);
    }

    #[test]
    fn mirror_is_daily_jsonl_0600() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("audit-{}", crate::v1::crypto::new_id("m")));
        let d = dir.to_str().unwrap();
        let db = Db::memory();
        append(&db, Some(d), Entry::new("claim.complete")).unwrap();
        append(&db, Some(d), Entry::new("auth.login")).unwrap();
        let f = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        assert!(f.file_name().unwrap().to_str().unwrap().starts_with("audit-20"));
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let text = std::fs::read_to_string(&f).unwrap();
        assert_eq!(text.lines().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
