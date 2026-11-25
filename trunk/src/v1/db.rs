//! trunk.db — SQLite WAL (spec §6), numbered migrations embedded in the binary.
//!
//! Numbers (CONTRACTS.md C1): IDP 001–099 (this list), WIRE 100–199 (`relay::MIGRATIONS`), others
//! ask the lead. The runner merges every list, sorts by number and applies what `schema_version`
//! (in `meta`) has not seen yet, each in its own transaction.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

/// (number, name, sql)
pub type Migration = (u32, &'static str, &'static str);

pub const IDP_MIGRATIONS: &[Migration] = &[(1, "idp_core", include_str!("migrations/001_idp_core.sql"))];

pub struct Db {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn all_migrations() -> Vec<Migration> {
    let mut v: Vec<Migration> = IDP_MIGRATIONS.iter().chain(super::relay::MIGRATIONS.iter()).copied().collect();
    v.sort_by_key(|m| m.0);
    v
}

impl Db {
    /// Open (creating mode 0600 if missing), WAL, foreign keys, migrations.
    pub fn open(path: &str) -> Result<Db, String> {
        use std::os::unix::fs::OpenOptionsExt as _;
        if let Some(d) = std::path::Path::new(path).parent() {
            if !d.as_os_str().is_empty() {
                std::fs::create_dir_all(d).map_err(|e| format!("db dir {}: {e}", d.display()))?;
            }
        }
        if !std::path::Path::new(path).exists() {
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|e| format!("db {path}: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("db {path}: {e}"))?;
        Db::init(conn)
    }

    pub fn memory() -> Db {
        Db::init(Connection::open_in_memory().expect("sqlite memory")).expect("migrations")
    }

    fn init(conn: Connection) -> Result<Db, String> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        c.execute_batch("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)").map_err(|e| e.to_string())?;
        let have: u32 = c
            .query_row("SELECT v FROM meta WHERE k = 'schema_version'", [], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let list = all_migrations();
        if let Some(w) = list.windows(2).find(|w| w[0].0 == w[1].0) {
            return Err(format!("two migrations numbered {}", w[0].0));
        }
        if let Some(max) = list.last().map(|m| m.0) {
            if have > max {
                return Err(format!("trunk.db schema_version {have} is newer than this binary ({max}) — refusing to run an older trunk on it"));
            }
        }
        for (n, name, sql) in list.into_iter().filter(|m| m.0 > have) {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(sql).map_err(|e| format!("migration {n:03}_{name}: {e}"))?;
            tx.execute("INSERT INTO meta (k, v) VALUES ('schema_version', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![n.to_string()])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Run `f` with the connection (short statements only: this is one lock for the process).
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut c).map_err(|e| format!("db: {e}"))
    }

    pub fn meta_get(&self, k: &str) -> Option<String> {
        self.with(|c| c.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0)).optional()).ok().flatten()
    }

    pub fn meta_set(&self, k: &str, v: &str) -> Result<(), String> {
        self.with(|c| c.execute("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![k, v]).map(|_| ()))
    }

    pub fn schema_version(&self) -> u32 {
        self.meta_get("schema_version").and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    pub fn table_exists(&self, name: &str) -> bool {
        self.with(|c| c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |_| Ok(())).optional())
            .ok()
            .flatten()
            .is_some()
    }

    /// `VACUUM INTO` a consistent copy (backup).
    pub fn snapshot_to(&self, path: &str) -> Result<(), String> {
        self.with(|c| c.execute("VACUUM INTO ?1", [path]).map(|_| ()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_once_and_record_the_version() {
        let db = Db::memory();
        let max = all_migrations().last().unwrap().0;
        assert_eq!(db.schema_version(), max);
        db.migrate().unwrap();
        assert_eq!(db.schema_version(), max);
        assert!(db.table_exists("accounts") && db.table_exists("audit") && db.table_exists("limits"));
        let n: i64 = db.with(|c| c.query_row("SELECT count(*) FROM claim", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 1, "claim is a singleton");
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let dir = std::env::temp_dir().join(format!("db-{}", crate::v1::crypto::new_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trunk.db");
        let ps = p.to_str().unwrap();
        {
            let db = Db::open(ps).unwrap();
            db.meta_set("schema_version", "9999").unwrap();
        }
        assert!(Db::open(ps).err().unwrap().contains("newer"));
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn file_db_is_wal() {
        let dir = std::env::temp_dir().join(format!("db-{}", crate::v1::crypto::new_id("w")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trunk.db");
        let db = Db::open(p.to_str().unwrap()).unwrap();
        let mode: String = db.with(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get(0))).unwrap();
        assert_eq!(mode, "wal");
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
