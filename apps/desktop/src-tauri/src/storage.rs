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
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
}

/// Ordered migrations; index + 1 is the schema version.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // RAD-205: agent principals and their bearer tokens (only a SHA-256 hash is stored).
    "CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
     );
     CREATE TABLE agent_tokens (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
     );
     CREATE INDEX agent_tokens_agent ON agent_tokens(agent_id);",
    // RAD-209: manuscripts, sections (one Yjs doc each), Yjs updates, comment and suggestion
    // indexes (CRDT marks are the source of truth), and the audit log of agent calls.
    "CREATE TABLE manuscripts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
     );
     CREATE TABLE sections (
        id TEXT PRIMARY KEY,
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id),
        kind TEXT NOT NULL CHECK (kind IN ('front_matter','part','chapter','scene','back_matter')),
        parent_id TEXT REFERENCES sections(id),
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        doc_id TEXT NOT NULL UNIQUE
     );
     CREATE INDEX sections_manuscript ON sections(manuscript_id, position);
     CREATE TABLE doc_updates (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        data BLOB NOT NULL
     );
     CREATE INDEX doc_updates_doc ON doc_updates(doc_id, seq);
     CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id),
        section_id TEXT NOT NULL REFERENCES sections(id),
        block_id TEXT,
        quote TEXT,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
     );
     CREATE INDEX comments_section ON comments(section_id);
     CREATE TABLE suggestions (
        id TEXT PRIMARY KEY,
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id),
        section_id TEXT NOT NULL REFERENCES sections(id),
        block_id TEXT,
        kind TEXT NOT NULL,
        quote TEXT,
        replacement TEXT,
        rationale TEXT,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
     );
     CREATE INDEX suggestions_section ON suggestions(section_id, status);
     CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manuscript_id TEXT,
        principal_kind TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL
     );",
];

#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
    conn: std::sync::Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(dir)?;
        let mut conn = Connection::open(dir.join("coauthor.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&mut conn)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            conn: std::sync::Arc::new(Mutex::new(conn)),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /// Run `f` with the locked connection (used by sibling modules such as `agents`).
    pub(crate) fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        f(&conn)
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
