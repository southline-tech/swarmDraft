//! Local-first storage: one data directory holding `coauthor.db` (SQLite).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Ordered migrations; index + 1 is the schema version.
const MIGRATIONS: &[&str] =
    &["CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"];

pub struct Store {
    dir: PathBuf,
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(dir)?;
        let mut conn = Connection::open(dir.join("coauthor.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&mut conn)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    pub fn schema_version(&self) -> Result<i64, StorageError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
    }
}

fn migrate(conn: &mut Connection) -> Result<(), StorageError> {
    migrate_with(conn, MIGRATIONS)
}

fn migrate_with(conn: &mut Connection, migrations: &[&str]) -> Result<(), StorageError> {
    // All pending migrations and the user_version bump commit atomically.
    let tx = conn.transaction()?;
    let current: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for sql in migrations.iter().skip(current as usize) {
        tx.execute_batch(sql)?;
    }
    if (current as usize) < migrations.len() {
        tx.pragma_update(None, "user_version", migrations.len() as i64)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_migrates_idempotently() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        drop(store);
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert!(tmp.path().join("coauthor.db").exists());
    }

    #[test]
    fn failed_migration_rolls_back_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        let bad: &[&str] = &["CREATE TABLE t (x INTEGER);", "NOT VALID SQL"];
        assert!(migrate_with(&mut conn, bad).is_err());
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 0);
        let t: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 't'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t, 0, "partial migration must roll back");
        migrate(&mut conn).unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }
}
