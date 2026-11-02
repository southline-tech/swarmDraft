//! Local-first storage: one data directory holding `swarmdraft.db` (SQLite).

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
    // #235: book author from import (title page byline), not inferred from stripped body.
    "ALTER TABLE manuscripts ADD COLUMN book_author TEXT;",
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
    // #159: per-manuscript spell dictionary and ignored words (Harper decoration layer).
    "CREATE TABLE spell_dictionary (
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
        word TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (manuscript_id, word)
     );
     CREATE INDEX spell_dictionary_manuscript ON spell_dictionary(manuscript_id);
     CREATE TABLE spell_ignored (
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
        word TEXT NOT NULL,
        PRIMARY KEY (manuscript_id, word)
     );",
    // #39: async Pandoc export jobs (EPUB 3 / .docx); PDF deferred to Typst slice.
    "CREATE TABLE export_jobs (
        id TEXT PRIMARY KEY,
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
        format TEXT NOT NULL CHECK (format IN ('epub','docx','pdf')),
        trim TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        file_path TEXT,
        error_message TEXT,
        log TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
     );
     CREATE INDEX export_jobs_manuscript ON export_jobs(manuscript_id, created_at);",
    // #188: MCP pairing requests and agent activity for connection status.
    "ALTER TABLE agents ADD COLUMN last_seen_at TEXT;
     CREATE TABLE agent_pairings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        requested_scopes TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        agent_id TEXT REFERENCES agents(id),
        approved_scopes TEXT,
        delivery_token TEXT
     );
     CREATE INDEX agent_pairings_status ON agent_pairings(status, expires_at);",
    // #188: short-lived claim while approve runs agent + token in one transaction.
    "CREATE TABLE agent_pairings_claim (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        requested_scopes TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approving','approved','denied','expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        agent_id TEXT REFERENCES agents(id),
        approved_scopes TEXT,
        delivery_token TEXT
     );
     INSERT INTO agent_pairings_claim SELECT * FROM agent_pairings;
     DROP TABLE agent_pairings;
     ALTER TABLE agent_pairings_claim RENAME TO agent_pairings;
     CREATE INDEX agent_pairings_status ON agent_pairings(status, expires_at);",
    // #178: suggestion index may mark overlapping remainders outdated after an accept.
    "PRAGMA foreign_keys=OFF;
     CREATE TABLE suggestions_outdated_mig (
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
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected','outdated')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
     );
     INSERT INTO suggestions_outdated_mig SELECT * FROM suggestions;
     DROP TABLE suggestions;
     ALTER TABLE suggestions_outdated_mig RENAME TO suggestions;
     CREATE INDEX suggestions_section ON suggestions(section_id, status);
     PRAGMA foreign_keys=ON;",
    // #244: per-agent draft access (selected list or all drafts including future).
    "ALTER TABLE agents ADD COLUMN manuscript_access_mode TEXT NOT NULL DEFAULT 'selected'
     CHECK (manuscript_access_mode IN ('selected', 'all'));
     UPDATE agents SET manuscript_access_mode = 'all';
     CREATE TABLE agent_manuscript_access (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, manuscript_id)
     );
     CREATE INDEX agent_manuscript_access_manuscript ON agent_manuscript_access(manuscript_id);",
    // #259: repair book_author for DBs that skipped the mid-array #235 migration (#251).
    // Sentinel — real work is `ensure_manuscripts_book_author` in `migrate_with`.
    BOOK_AUTHOR_REPAIR_MIGRATION,
];

/// Sentinel for the #259 trailing repair; not executed as SQL.
const BOOK_AUTHOR_REPAIR_MIGRATION: &str = "__swarmdraft_repair_book_author__";

/// SHA-256 of the 14 migrations before #259 (length-prefixed). Update only when appending.
#[cfg(test)]
const PINNED_MIGRATIONS_SHA256: &str =
    "fca77a34d7f7708d5d0ef486097254e67ec7da150265519670296d44227b9466";

/// How long a statement waits on a locked database before failing.
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// Live database file name for new installs (#198).
pub const DB_FILENAME: &str = "swarmdraft.db";

/// Pre-rename database file name; still opened when present (#198).
pub const LEGACY_DB_FILENAME: &str = "coauthor.db";

/// Path to the database file in `dir`: prefers `swarmdraft.db`, then legacy `coauthor.db`, else
/// `swarmdraft.db` for creation.
pub fn db_path(dir: &Path) -> PathBuf {
    let modern = dir.join(DB_FILENAME);
    if modern.is_file() {
        return modern;
    }
    let legacy = dir.join(LEGACY_DB_FILENAME);
    if legacy.is_file() {
        return legacy;
    }
    modern
}

/// Sidecar extensions for a database file at `db`.
fn db_side_paths(db: &Path) -> [PathBuf; 3] {
    let base = db.as_os_str().to_owned();
    ["-wal", "-shm", "-journal"].map(|ext| {
        let mut p = base.clone();
        p.push(ext);
        PathBuf::from(p)
    })
}

/// After opening a legacy file, rename it (and sidecars) to [`DB_FILENAME`].
fn promote_legacy_db(dir: &Path) -> Result<(), StorageError> {
    let legacy = dir.join(LEGACY_DB_FILENAME);
    if !legacy.is_file() {
        return Ok(());
    }
    let modern = dir.join(DB_FILENAME);
    if modern.exists() {
        return Ok(());
    }
    std::fs::rename(&legacy, &modern)?;
    for (from, to) in db_side_paths(&legacy)
        .into_iter()
        .zip(db_side_paths(&modern))
    {
        if from.is_file() {
            let _ = std::fs::rename(from, to);
        }
    }
    Ok(())
}

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
        let mut path = db_path(dir);
        let using_legacy = path.file_name().is_some_and(|n| n == LEGACY_DB_FILENAME);
        let mut conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Fail fast when another process holds the database: a locked file used to stall each
        // call ~5 s (rusqlite's default) and the UI's retries added up to tens of seconds.
        conn.busy_timeout(BUSY_TIMEOUT)?;
        migrate(&mut conn)?;
        if using_legacy {
            conn.close().map_err(|(_, e)| StorageError::Sqlite(e))?;
            promote_legacy_db(dir)?;
            path = dir.join(DB_FILENAME);
            conn = Connection::open(&path)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.busy_timeout(BUSY_TIMEOUT)?;
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            conn: std::sync::Arc::new(Mutex::new(conn)),
            known_tokens: std::sync::Arc::default(),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /// Root for a pinned Pandoc install downloaded on first export (#186). Not bundled in the installer.
    pub fn pandoc_root_dir(&self) -> std::path::PathBuf {
        self.data_dir().join("pandoc")
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

    /// Like `with_conn_mut`, for closures returning `StorageError`.
    pub(crate) fn with_conn_mut_storage<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        f(&mut conn)
    }

    /// Mark suggestion index rows outdated (#178). Missing ids are ignored.
    pub fn mark_suggestions_outdated(
        &self,
        section_id: &str,
        ids: &[String],
        marked_at: &str,
        marked_by: &str,
    ) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            for id in ids {
                tx.execute(
                    "UPDATE suggestions SET status = 'outdated', decided_at = ?1, decided_by = ?2
                     WHERE section_id = ?3 AND id = ?4 AND status = 'open'",
                    rusqlite::params![marked_at, marked_by, section_id, id],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Remove outdated index rows without changing section text (#179 dismiss wiring).
    pub fn dismiss_outdated_suggestions(
        &self,
        section_id: &str,
        ids: &[String],
    ) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            for id in ids {
                tx.execute(
                    "DELETE FROM suggestions WHERE section_id = ?1 AND id = ?2 AND status = 'outdated'",
                    rusqlite::params![section_id, id],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Suggestions in a section with the given index status (`open`, `outdated`, …).
    pub fn suggestions_with_status(
        &self,
        section_id: &str,
        status: &str,
    ) -> Result<Vec<crate::manuscripts::Suggestion>, StorageError> {
        use crate::manuscripts::{row_suggestion, SUGGESTION_COLS};
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {SUGGESTION_COLS} FROM suggestions WHERE section_id = ?1 AND status = ?2
                 ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map(rusqlite::params![section_id, status], row_suggestion)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
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
        if *sql == BOOK_AUTHOR_REPAIR_MIGRATION {
            ensure_manuscripts_book_author(&tx)?;
        } else {
            tx.execute_batch(sql)?;
        }
    }
    if (current as usize) < migrations.len() {
        tx.pragma_update(None, "user_version", migrations.len() as i64)?;
    }
    tx.commit()?;
    Ok(())
}

/// #259: add `manuscripts.book_author` only when missing (upgraded DBs that skipped mid-array #235).
fn ensure_manuscripts_book_author(tx: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    let mut stmt = tx.prepare("PRAGMA table_info(manuscripts)")?;
    let has = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .any(|name| name == "book_author");
    drop(stmt);
    if !has {
        tx.execute_batch("ALTER TABLE manuscripts ADD COLUMN book_author TEXT;")?;
    }
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
        assert!(tmp.path().join(DB_FILENAME).exists());
    }

    #[test]
    fn opens_legacy_coauthor_db_and_promotes_to_swarmdraft() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join(LEGACY_DB_FILENAME);
        Connection::open(&legacy).unwrap();
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert!(tmp.path().join(DB_FILENAME).is_file());
        assert!(!legacy.is_file());
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
            let mut conn = Connection::open(tmp.path().join(LEGACY_DB_FILENAME)).unwrap();
            migrate_with(&mut conn, &MIGRATIONS[..5]).unwrap();
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

    #[test]
    fn outdated_status_persists_and_dismiss_clears() {
        use crate::manuscripts::{Author, Suggestion};
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let m = store.create_manuscript("t").unwrap();
        let sec = store.add_section(&m.id, "chapter", "One", None).unwrap();
        let x = Suggestion {
            id: "s9".into(),
            section_id: sec.id.clone(),
            block_id: None,
            kind: "replace".into(),
            quote: Some("old".into()),
            replacement: Some("new".into()),
            rationale: None,
            author: Author {
                kind: "agent".into(),
                id: "bot1".into(),
                name: "Bot".into(),
            },
            status: "open".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        store.insert_suggestion(&m.id, &x).unwrap();
        store
            .mark_suggestions_outdated(&sec.id, &["s9".into()], "2026-01-02T00:00:00Z", "human:me")
            .unwrap();
        let outdated = store.suggestions_with_status(&sec.id, "outdated").unwrap();
        assert_eq!(outdated.len(), 1);
        assert_eq!(outdated[0].status, "outdated");
        drop(store);
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(
            store
                .suggestions_with_status(&sec.id, "outdated")
                .unwrap()
                .len(),
            1
        );
        store
            .dismiss_outdated_suggestions(&sec.id, &["s9".into()])
            .unwrap();
        assert!(store
            .suggestions_with_status(&sec.id, "outdated")
            .unwrap()
            .is_empty());
    }

    /// Indices of migrations that existed before #251 inserted `book_author` mid-array.
    /// Pre-#251 `user_version=12` == these 12 SQL entries (no book_author, no agent access, no #259).
    fn pre_251_migrations() -> Vec<&'static str> {
        MIGRATIONS
            .iter()
            .copied()
            .take_while(|sql| *sql != BOOK_AUTHOR_REPAIR_MIGRATION)
            .enumerate()
            .filter(|(i, sql)| {
                // Skip mid-array book_author (#235) and trailing agent-access (#244).
                *i != 5 && !sql.contains("agent_manuscript_access")
            })
            .map(|(_, sql)| sql)
            .collect()
    }

    fn manuscript_column_names(store: &Store) -> Vec<String> {
        let conn = store.conn.lock().expect("store mutex poisoned");
        let mut stmt = conn.prepare("PRAGMA table_info(manuscripts)").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    }

    #[test]
    fn existing_migrations_are_pinned() {
        use sha2::{Digest, Sha256};
        // First 14 entries (everything before the #259 repair sentinel) must not change.
        let pinned: Vec<&str> = MIGRATIONS
            .iter()
            .copied()
            .take_while(|sql| *sql != BOOK_AUTHOR_REPAIR_MIGRATION)
            .collect();
        assert_eq!(
            pinned.len(),
            14,
            "expected 14 migrations before #259 repair"
        );
        let mut hasher = Sha256::new();
        for sql in &pinned {
            hasher.update((sql.len() as u64).to_le_bytes());
            hasher.update(sql.as_bytes());
            hasher.update([0xff]);
        }
        let digest = format!("{:x}", hasher.finalize());
        // Update only when intentionally appending (never editing) prior migrations.
        assert_eq!(
            digest, PINNED_MIGRATIONS_SHA256,
            "existing MIGRATIONS entries changed; append-only — do not edit or reorder"
        );
    }

    #[test]
    fn book_author_repair_from_pre_251_schema() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join(DB_FILENAME);
        {
            let mut conn = Connection::open(&db).unwrap();
            let pre = pre_251_migrations();
            assert_eq!(pre.len(), 12, "pre-#251 had 12 migrations");
            migrate_with(&mut conn, &pre).unwrap();
            let v: i64 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(v, 12);
            let cols: Vec<String> = {
                let mut stmt = conn.prepare("PRAGMA table_info(manuscripts)").unwrap();
                stmt.query_map([], |r| r.get::<_, String>(1))
                    .unwrap()
                    .map(|c| c.unwrap())
                    .collect()
            };
            assert!(
                !cols.iter().any(|c| c == "book_author"),
                "fixture must lack book_author"
            );
            conn.execute(
                "INSERT INTO manuscripts (id, title, created_at, numbering_style) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["m1", "Draft", "2026-01-01T00:00:00Z", "chapter_arabic"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sections (id, manuscript_id, kind, parent_id, position, title, doc_id)                  VALUES (?1, ?2, 'chapter', NULL, 0, 'One', 'd1')",
                rusqlite::params!["s1", "m1"],
            )
            .unwrap();
        }
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let cols = manuscript_column_names(&store);
        for expected in [
            "id",
            "title",
            "created_at",
            "numbering_style",
            "book_author",
        ] {
            assert!(
                cols.iter().any(|c| c == expected),
                "missing column {expected}"
            );
        }
        let listed = store.list_manuscripts().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "m1");
        assert!(listed[0].book_author.is_none());
        let got = store.get_manuscript("m1").unwrap();
        assert_eq!(got.title, "Draft");
        let loaded = store.load_manuscript("m1").unwrap();
        assert_eq!(loaded.manuscript.id, "m1");
        assert_eq!(loaded.sections.len(), 1);
    }

    #[test]
    fn book_author_repair_fresh_install_has_column() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let cols = manuscript_column_names(&store);
        assert!(cols.iter().any(|c| c == "book_author"));
        let blank = store.create_blank_manuscript().unwrap();
        let listed = store.list_manuscripts().unwrap();
        assert!(listed.iter().any(|m| m.id == blank.manuscript.id));
        let loaded = store.load_manuscript(&blank.manuscript.id).unwrap();
        assert_eq!(loaded.manuscript.id, blank.manuscript.id);
    }

    #[test]
    fn book_author_repair_already_has_column_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        assert!(manuscript_column_names(&store)
            .iter()
            .any(|c| c == "book_author"));
        // Simulate a DB that already applied mid-array #235 and is at the pre-repair version.
        {
            let conn = store.conn.lock().expect("store mutex poisoned");
            conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 - 1)
                .unwrap();
        }
        drop(store);
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert!(manuscript_column_names(&store)
            .iter()
            .any(|c| c == "book_author"));
        // Second open must stay stable.
        drop(store);
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let m = store.create_manuscript("idem").unwrap();
        assert!(store.get_manuscript(&m.id).unwrap().book_author.is_none());
    }

    #[test]
    fn book_author_repair_from_v14_missing_column() {
        // Arm-A-Rillo production shape: user_version=14, agent access present, no book_author.
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join(DB_FILENAME);
        {
            let mut conn = Connection::open(&db).unwrap();
            let without_ba: Vec<&str> = MIGRATIONS
                .iter()
                .copied()
                .take_while(|sql| *sql != BOOK_AUTHOR_REPAIR_MIGRATION)
                .enumerate()
                .filter(|(i, _)| *i != 5)
                .map(|(_, sql)| sql)
                .collect();
            assert_eq!(without_ba.len(), 13);
            migrate_with(&mut conn, &without_ba).unwrap();
            conn.pragma_update(None, "user_version", 14i64).unwrap();
            let cols: Vec<String> = {
                let mut stmt = conn.prepare("PRAGMA table_info(manuscripts)").unwrap();
                stmt.query_map([], |r| r.get::<_, String>(1))
                    .unwrap()
                    .map(|c| c.unwrap())
                    .collect()
            };
            assert!(!cols.iter().any(|c| c == "book_author"));
            conn.execute(
                "INSERT INTO manuscripts (id, title, created_at, numbering_style) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["m2", "Live", "2026-02-01T00:00:00Z", "chapter_arabic"],
            )
            .unwrap();
        }
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert!(manuscript_column_names(&store)
            .iter()
            .any(|c| c == "book_author"));
        assert_eq!(store.list_manuscripts().unwrap()[0].id, "m2");
        assert_eq!(store.get_manuscript("m2").unwrap().title, "Live");
        assert_eq!(store.load_manuscript("m2").unwrap().manuscript.id, "m2");
    }
}
