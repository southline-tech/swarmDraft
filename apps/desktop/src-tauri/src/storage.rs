//! Local-first storage: one data directory holding `coauthor.db` (SQLite).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

/// `app_meta` key holding the id of the restore that produced the live db.
pub(crate) const RESTORE_ID_KEY: &str = "last_restore_id";

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
        kind TEXT NOT NULL CHECK (kind IN ('front_matter','part','chapter','back_matter')),
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
    "ALTER TABLE manuscripts ADD COLUMN numbering_style TEXT NOT NULL DEFAULT 'chapter_arabic' \
     CHECK (numbering_style IN ('chapter_arabic','chapter_words','chapter_upper','number_only'));",
    // #111: rows that picked up the provisional column default before INSERT was fixed.
    "UPDATE manuscripts SET numbering_style = 'chapter_arabic' WHERE numbering_style = 'chapter_words';",
    // #76: stable primary-agent flag (P1 bot keeps collab-1 by id, not display name).
    "ALTER TABLE agents ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));
     CREATE UNIQUE INDEX agents_one_primary ON agents(is_primary) WHERE is_primary = 1;
     UPDATE agents SET is_primary = 1 WHERE id = (
         SELECT id FROM agents WHERE revoked_at IS NULL AND lower(trim(name)) = 'grok bot'
         ORDER BY created_at, id LIMIT 1
     );",
    // #51: human accept/reject records for tracked changes (CRDT marks), keyed by section.
    "CREATE TABLE review_decisions (
        section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('suggestion_insert','suggestion_delete')),
        suggestion_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted','rejected')),
        decided_at TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        PRIMARY KEY (section_id, kind, suggestion_id)
     );
     CREATE INDEX review_decisions_section ON review_decisions(section_id);",
];

/// How long a statement waits on a locked database before failing.
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
    conn: std::sync::Arc<Mutex<Connection>>,
    /// Hashes of tokens that authenticated recently (used by the MCP gate). Revoking a token
    /// or agent removes its hashes here.
    known_tokens: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(dir)?;
        let mut conn = Connection::open(dir.join("coauthor.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Fail fast when another process holds the database: a locked file used to stall each
        // call ~5 s (rusqlite's default) and the UI's retries added up to tens of seconds.
        conn.busy_timeout(BUSY_TIMEOUT)?;
        migrate(&mut conn)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            conn: std::sync::Arc::new(Mutex::new(conn)),
            known_tokens: std::sync::Arc::default(),
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

    /// Like `with_conn`, for closures returning plain rusqlite results.
    pub(crate) fn with_sql<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StorageError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Ok(f(&conn)?)
    }

    /// Run `f` with mutable access to the shared connection.
    pub fn with_conn_mut<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StorageError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        Ok(f(&mut conn)?)
    }

    /// Prepare a staged database file for restore: migrate it, stamp `restore_id` into
    /// `app_meta`, and, when `revoke_tokens`,
    /// revoke every agent token *in the staged file*, before it is swapped in. The revoke is
    /// thus durable before the live db changes, so a crash mid-restore cannot revive the
    /// backup's tokens. Returns the number of tokens revoked.
    pub(crate) fn prepare_restore_db(
        src: &Path,
        revoke_tokens: bool,
        restore_id: &str,
    ) -> Result<u64, StorageError> {
        let mut conn = Connection::open(src)?;
        migrate(&mut conn)?;
        let tx = conn.transaction()?;
        let n = if revoke_tokens {
            tx.execute(
                "UPDATE agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                 WHERE revoked_at IS NULL",
                [],
            )?
        } else {
            0
        };
        // Lets startup recovery tell whether the live db is this restore's db (see backup.rs).
        tx.execute(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)",
            [RESTORE_ID_KEY, restore_id],
        )?;
        tx.commit()?;
        conn.close().map_err(|(_, e)| e)?;
        Ok(n as u64)
    }

    /// Replace the live database with `src` (SQLite backup API) and migrate it, under one
    /// lock so no request sees a half-restored state. `src` should already be prepared with
    /// [`Store::prepare_restore_db`].
    pub(crate) fn restore_db_from(&self, src: &Path) -> Result<(), StorageError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        conn.restore(
            rusqlite::DatabaseName::Main,
            src,
            None::<fn(rusqlite::backup::Progress)>,
        )?;
        migrate(&mut conn)
    }

    /// Apply any pending migrations (e.g. after restoring an older backup).
    pub fn migrate_now(&self) -> Result<(), StorageError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        migrate(&mut conn)
    }

    /// True if this token hash authenticated before and hasn't been revoked since.
    pub fn is_known_token_hash(&self, hash: &str) -> bool {
        self.known_tokens
            .lock()
            .expect("cache poisoned")
            .contains(hash)
    }

    /// Remember a token hash that just authenticated (bounded; cleared when full).
    pub fn remember_token_hash(&self, hash: String) {
        let mut k = self.known_tokens.lock().expect("cache poisoned");
        if k.len() >= 1024 {
            k.clear();
        }
        k.insert(hash);
    }

    /// Drop every cached token hash (call after a restore or any out-of-band DB change).
    pub fn clear_token_cache(&self) {
        self.known_tokens.lock().expect("cache poisoned").clear();
    }

    pub(crate) fn forget_token_hashes(&self, hashes: &[String]) {
        let mut k = self.known_tokens.lock().expect("cache poisoned");
        for h in hashes {
            k.remove(h);
        }
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

    #[test]
    fn primary_flag_migration_backfills_grok_bot() {
        use crate::agents::DEFAULT_AGENT_NAME;
        let tmp = tempfile::tempdir().unwrap();
        {
            let mut conn = Connection::open(tmp.path().join("coauthor.db")).unwrap();
            migrate_with(&mut conn, &MIGRATIONS[..MIGRATIONS.len() - 2]).unwrap();
            conn.execute(
                "INSERT INTO agents (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["a1", "Line Editor", "#3366ff", "2026-01-01T00:00:00Z"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agents (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["a2", DEFAULT_AGENT_NAME, "#3366ff", "2026-01-02T00:00:00Z"],
            )
            .unwrap();
        }
        let s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let grok = s
            .list_agents()
            .unwrap()
            .into_iter()
            .find(|a| a.id == "a2")
            .unwrap();
        assert!(grok.primary);
        assert_eq!(s.primary_agent_id().unwrap().as_deref(), Some("a2"));
    }
}
