//! trunk.db — SQLite WAL (spec §6), numbered migrations embedded in the binary.
//!
//! Numbers (CONTRACTS.md C1): IDP 001–099 (this list), WIRE 100–199 (`relay::MIGRATIONS`), others
//! ask the lead. The runner merges every list, sorts by number and applies what `schema_version`
//! (in `meta`) has not seen yet, each in its own transaction.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

/// (number, name, sql)
pub type Migration = (u32, &'static str, &'static str);

pub const IDP_MIGRATIONS: &[Migration] = &[
    (1, "idp_core", include_str!("migrations/001_idp_core.sql")),
    (2, "auth_challenges", include_str!("migrations/002_auth_challenges.sql")),
];

pub struct Db {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The migrations every binary had before `schema_migrations` existed (M1–M3: 001, 100).
const LEGACY: &[u32] = &[1, 100];

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
        // Each stream numbers in its own range (IDP 001–099, WIRE 100–199), so a high-water mark
        // alone would skip a new low number once a higher one ran: every applied number is kept.
        let tracked: bool = c
            .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'", [], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !tracked {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch("CREATE TABLE schema_migrations (n INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)")
                .map_err(|e| e.to_string())?;
            // a db from before this table ran exactly the migrations every such binary had
            for (n, name, _) in list.iter().filter(|m| LEGACY.contains(&m.0) && m.0 <= have) {
                tx.execute("INSERT INTO schema_migrations (n, name, applied_at) VALUES (?1, ?2, 0)", params![n, name]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        let applied: Vec<u32> = {
            let mut s = c.prepare("SELECT n FROM schema_migrations").map_err(|e| e.to_string())?;
            s.query_map([], |r| r.get::<_, u32>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if let Some(n) = applied.iter().find(|n| !list.iter().any(|m| m.0 == **n)) {
            return Err(format!("trunk.db has migration {n:03}, which this binary does not know — refusing to run an older trunk on it"));
        }
        for (n, name, sql) in list.into_iter().filter(|m| !applied.contains(&m.0)) {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(sql).map_err(|e| format!("migration {n:03}_{name}: {e}"))?;
            tx.execute("INSERT INTO schema_migrations (n, name, applied_at) VALUES (?1, ?2, ?3)", params![n, name, now_ms()]).map_err(|e| e.to_string())?;
            let top: u32 = tx.query_row("SELECT max(n) FROM schema_migrations", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO meta (k, v) VALUES ('schema_version', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![top.to_string()])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Run `f` with the connection (short statements only: this is one lock for the process).
    /// The locked connection, for work that needs its own transaction shape (WIRE's import-v0:
    /// string errors inside a transaction). The lock is held while the closure runs.
    pub fn with_tx(&self, f: impl FnOnce(&mut Connection) -> Result<(), String>) -> Result<(), String> {
        let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut c).map_err(|e| format!("db: {e}"))
    }

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
    fn a_new_low_number_still_runs_after_a_higher_one() {
        // a db made by an M3 binary: 001 + 100 ran, schema_version 100, no schema_migrations
        let dir = std::env::temp_dir().join(format!("db-{}", crate::v1::crypto::new_id("m")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trunk.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)").unwrap();
            for (n, _, sql) in all_migrations().iter().filter(|m| LEGACY.contains(&m.0)) {
                c.execute_batch(sql).unwrap();
                c.execute("INSERT INTO meta (k, v) VALUES ('schema_version', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [n.to_string()]).unwrap();
            }
        }
        let db = Db::open(p.to_str().unwrap()).unwrap();
        assert!(db.table_exists("auth_challenges"), "002 ran after 100");
        let ns: Vec<u32> = db.with(|c| c.prepare("SELECT n FROM schema_migrations ORDER BY n")?.query_map([], |r| r.get(0))?.collect()).unwrap();
        assert_eq!(ns, all_migrations().iter().map(|m| m.0).collect::<Vec<_>>());
        assert_eq!(db.schema_version(), all_migrations().last().unwrap().0);
        // and a number this binary does not know is refused
        db.with(|c| c.execute("INSERT INTO schema_migrations (n, name, applied_at) VALUES (99, 'future', 1)", [])).unwrap();
        drop(db);
        assert!(Db::open(p.to_str().unwrap()).err().unwrap().contains("does not know"));
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
