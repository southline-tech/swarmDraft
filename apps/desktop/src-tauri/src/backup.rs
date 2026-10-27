//! Backup and restore (RAD-224).
//!
//! A backup is a `.zip` with:
//! - `manifest.json`: format id/version, app + schema version, creation time, file list and
//!   a SHA-256 for every other entry.
//! - `db/coauthor.db`: a consistent snapshot of the WAL-mode database taken with
//!   `VACUUM INTO` (every table: manuscripts, Yjs doc updates, comments, suggestions, ...).
//!   Once agent identities are on main this includes agent token *hashes* (never plaintext
//!   tokens); restoring a backup brings those agents back.
//! - `files/...`: everything under the data dir's `files/` folder (images, attachments).
//!
//! Restore validates the archive (manifest vs entries, hashes, safe entry names, SQLite
//! integrity, schema version not newer than this build) before touching anything, writes a
//! uniquely named `pre-restore-*.zip` snapshot, swaps `files/` by rename and the database in
//! with the SQLite backup API. Any error after the snapshot rolls back automatically.
//! Every restore revokes all agent tokens (agents are kept) so a backup can never revive a
//! token revoked after it was taken (RAD-234).
//!
//! Backup/restore are desktop (human) commands only and must never be exposed as MCP tools.
//!
//! Follow-up once the editor lands: flush pending Yjs updates before backup, and close/reload
//! in-memory Yjs docs after restore so stale editor state cannot write over restored data.

use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::storage::{StorageError, Store};

/// Manifest format id. Kept as `coauthor-backup` so backups made before the rename still
/// restore; only the default file name changed to `swarmdraft-backup-*` (#73).
pub const FORMAT: &str = "coauthor-backup";
pub const FORMAT_VERSION: u32 = 1;
const DB_ENTRY: &str = "db/coauthor.db";
const MANIFEST_ENTRY: &str = "manifest.json";
const FILES_PREFIX: &str = "files/";
const MAX_MANIFEST_BYTES: u64 = 16 << 20;
/// Refuse absurd archives (zip bombs): 2 GiB uncompressed total.
const MAX_TOTAL_BYTES: u64 = 2 << 30;
/// Temp-name prefixes in the data dir; leftovers are removed by [`cleanup_temp`].
const TMP_PREFIXES: &[&str] = &[".backup-", ".restore-", ".files-old-"];
// (".restore-trash-*" is covered by ".restore-".)

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at_unix: u64,
    /// Paths under `files/` (relative, `/`-separated).
    pub files: Vec<String>,
    /// Hex SHA-256 of every entry except the manifest, keyed by entry name.
    pub sha256: BTreeMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("invalid backup: {0}")]
    Invalid(String),
    #[error("restore failed and was rolled back: {0}")]
    RolledBack(String),
    #[error("restore failed ({0}) and rollback also failed ({1}); previous state is in {2}")]
    RollbackFailed(String, String, String),
}

fn invalid(msg: impl Into<String>) -> BackupError {
    BackupError::Invalid(msg.into())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `<ms>-<pid>-<counter>`: unique within and across processes.
fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        now_ms(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn backups_dir(store: &Store) -> PathBuf {
    store.data_dir().join("backups")
}

/// Default file name offered for a new backup: `swarmdraft-backup-<stamp>.zip`.
pub fn backup_file_name(stamp: &str) -> String {
    format!("swarmdraft-backup-{stamp}.zip")
}

/// Unique backup path in the backups folder. Tests only: the app never writes a backup
/// without the save dialog (#73).
#[cfg(test)]
fn default_backup_path(store: &Store) -> PathBuf {
    backups_dir(store).join(backup_file_name(&unique_suffix()))
}

fn files_dir(store: &Store) -> PathBuf {
    store.data_dir().join("files")
}

/// Journal written (and fsynced) before a restore touches `files/`; removed once the db copy
/// has committed. Holds the restore id and the name of the moved-aside old `files/` dir.
const JOURNAL: &str = ".restore-journal";

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    id: String,
    /// `.files-old-*` dir name, if there was a `files/` dir to move aside.
    old: Option<String>,
    /// Pre-restore snapshot path, for the recovery notice.
    #[serde(default)]
    snapshot: Option<String>,
    /// Set once startup recovery has quarantined against this journal. From then on the live
    /// `files/` may hold the user's new attachments, so it is only ever moved aside.
    #[serde(default)]
    quarantined: bool,
}

/// Notices left by startup recovery whenever it moved folders aside (or could not finish).
/// Kept until the user dismisses them in the UI.
const RECOVERY_NOTICE: &str = "recovery-notice.json";

/// How long startup recovery waits for a locked database (antivirus, backup tools, a second
/// instance) before it treats the restore state as unknown.
const RECOVERY_BUSY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotice {
    /// Stable id, so Dismiss removes only the notices that were shown.
    #[serde(default)]
    pub id: String,
    /// `recovery-<unique>` folder holding what was moved, if anything was actually moved.
    #[serde(default)]
    pub folder: Option<String>,
    /// Names (inside `folder`) of the items that were actually moved there.
    #[serde(default)]
    pub moved: Vec<String>,
    /// Pre-restore snapshot, if known.
    #[serde(default)]
    pub snapshot: Option<String>,
    /// The attachments folder the user can copy files back into.
    #[serde(default)]
    pub files_dir: String,
    pub reason: String,
    /// True when recovery could not finish and will try again at the next start.
    #[serde(default)]
    pub retry_pending: bool,
    /// Set when the notice could not be saved to disk (it is then only kept in memory).
    #[serde(default)]
    pub save_error: Option<String>,
    /// A notice file that could not be read was kept here (never deleted).
    #[serde(default)]
    pub corrupt_file: Option<String>,
}

fn notice_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RECOVERY_NOTICE)
}

impl RecoveryNotice {
    fn new(data_dir: &Path, reason: String) -> Self {
        RecoveryNotice {
            id: String::new(),
            folder: None,
            moved: Vec::new(),
            snapshot: None,
            files_dir: data_dir.join("files").display().to_string(),
            reason,
            retry_pending: false,
            save_error: None,
            corrupt_file: None,
        }
    }

    /// Content hash (ignoring `id`/`save_error`): used as the id and to skip duplicates.
    fn content_id(&self) -> String {
        let mut c = self.clone();
        c.id = String::new();
        c.save_error = None;
        let d = Sha256::digest(serde_json::to_vec(&c).expect("notice serializes"));
        hex(&d[..8])
    }
}

fn parse_notices(b: &[u8]) -> serde_json::Result<Vec<RecoveryNotice>> {
    serde_json::from_slice::<Vec<RecoveryNotice>>(b)
        .or_else(|_| serde_json::from_slice::<RecoveryNotice>(b).map(|n| vec![n]))
        .map(|mut v| {
            for n in &mut v {
                if n.id.is_empty() {
                    n.id = n.content_id();
                }
            }
            v
        })
}

fn write_notices(data_dir: &Path, all: &[RecoveryNotice]) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_NOTICE_WRITE.with(|f| f.get()) {
        return Err(std::io::Error::other("simulated notice write failure"));
    }
    if all.is_empty() {
        return match std::fs::remove_file(notice_path(data_dir)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let tmp = data_dir.join(format!(".restore-notice-tmp-{}", unique_suffix()));
    let mut f = File::create(&tmp)?;
    f.write_all(&serde_json::to_vec_pretty(all).expect("notice serializes"))?;
    f.sync_all()?;
    drop(f);
    rename_retry(&tmp, &notice_path(data_dir))?;
    sync_dir(data_dir);
    Ok(())
}

/// Load saved notices. A file that can't be parsed is never overwritten or deleted: it is
/// renamed to `recovery-notice.corrupt-<unique>.json` and a notice pointing at it is returned
/// (and saved). Errors only when the corrupt file could not be set aside.
fn load_notices(data_dir: &Path) -> std::io::Result<Vec<RecoveryNotice>> {
    let p = notice_path(data_dir);
    let bytes = match std::fs::read(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    match parse_notices(&bytes) {
        Ok(v) => Ok(v),
        Err(err) => {
            let kept = data_dir.join(format!("recovery-notice.corrupt-{}.json", unique_suffix()));
            rename_retry(&p, &kept)?;
            sync_dir(data_dir);
            eprintln!(
                "coAuthor: recovery notice file was unreadable ({err}); kept as {}",
                kept.display()
            );
            let mut n = RecoveryNotice::new(
                data_dir,
                format!("an earlier recovery notice could not be read: {err}"),
            );
            n.corrupt_file = Some(kept.display().to_string());
            n.id = n.content_id();
            let v = vec![n];
            if let Err(e) = write_notices(data_dir, &v) {
                eprintln!("coAuthor: could not save the recovery notice: {e}");
            }
            Ok(v)
        }
    }
}

/// Recovery notices waiting to be dismissed. Reading does not clear them.
pub fn read_recovery_notices(data_dir: &Path) -> Vec<RecoveryNotice> {
    load_notices(data_dir).unwrap_or_else(|e| {
        eprintln!("coAuthor: recovery notice file could not be read: {e}");
        let mut n = RecoveryNotice::new(
            data_dir,
            format!("the recovery notice file could not be read: {e}"),
        );
        n.corrupt_file = Some(notice_path(data_dir).display().to_string());
        n.id = n.content_id();
        vec![n]
    })
}

/// Remove the notices with these ids (the ones the user saw and dismissed); others stay.
pub fn dismiss_recovery_notices(data_dir: &Path, ids: &[String]) -> std::io::Result<()> {
    let mut all = load_notices(data_dir)?;
    let before = all.len();
    all.retain(|n| !ids.contains(&n.id));
    if all.len() == before {
        return Ok(());
    }
    write_notices(data_dir, &all)
}

/// Append `n` to the notice file (atomically). Identical notices are not duplicated.
fn save_notice(data_dir: &Path, n: &RecoveryNotice) -> std::io::Result<()> {
    let mut all = load_notices(data_dir)?;
    if all.iter().any(|o| o.id == n.id) {
        return Ok(());
    }
    all.push(n.clone());
    write_notices(data_dir, &all)
}

/// Save a notice; if that fails, log it and keep it in `unsaved` so the UI still shows it.
fn notify(data_dir: &Path, mut n: RecoveryNotice, unsaved: &mut Vec<RecoveryNotice>) {
    n.id = n.content_id();
    if let Err(e) = save_notice(data_dir, &n) {
        eprintln!("coAuthor: could not save the recovery notice: {e}");
        n.save_error = Some(e.to_string());
        unsaved.push(n);
    }
}

fn write_journal(data_dir: &Path, j: &Journal) -> std::io::Result<()> {
    let tmp = data_dir.join(format!(".restore-journal-tmp-{}", unique_suffix()));
    let mut f = File::create(&tmp)?;
    f.write_all(&serde_json::to_vec(j).expect("journal serializes"))?;
    f.sync_all()?;
    drop(f);
    rename_retry(&tmp, &data_dir.join(JOURNAL))?;
    sync_dir(data_dir);
    Ok(())
}

fn remove_journal(data_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(data_dir.join(JOURNAL)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => {
            sync_dir(data_dir);
            Ok(())
        }
    }
}

/// Best-effort directory fsync so renames are durable (no-op where unsupported).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

/// Restore id recorded in the live db. `Ok(None)` means the db (or the row) is definitely
/// absent; `Err` means it could not be read, so the state is unknown. A locked db is waited
/// on (SQLite busy timeout plus a bounded retry) for up to `busy` before giving up.
fn live_restore_id(data_dir: &Path, busy: Duration) -> Result<Option<String>, rusqlite::Error> {
    use rusqlite::OptionalExtension;
    let db = data_dir.join("coauthor.db");
    if !db.exists() {
        return Ok(None);
    }
    let deadline = Instant::now() + busy;
    let mut logged = false;
    loop {
        let r = (|| {
            let c = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            c.busy_timeout(deadline.saturating_duration_since(Instant::now()))?;
            c.query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [crate::storage::RESTORE_ID_KEY],
                |r| r.get(0),
            )
            .optional()
        })();
        match r {
            Err(e) if is_busy(&e) && Instant::now() < deadline => {
                if !logged {
                    eprintln!(
                        "coAuthor: database is locked; waiting up to {}s before recovery",
                        busy.as_secs_f32()
                    );
                    logged = true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            r => return r,
        }
    }
}

/// Move `path` into `<data dir>/recovery-<unique>/<label>` instead of deleting it.
fn move_to_recovery(data_dir: &Path, path: &Path, label: &str) -> std::io::Result<PathBuf> {
    let dir = data_dir.join(format!("recovery-{}", unique_suffix()));
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(label);
    if let Err(e) = rename_retry(path, &dest) {
        let _ = std::fs::remove_dir(&dir); // only ever empty here
        return Err(e);
    }
    Ok(dest)
}

/// Outcome of startup recovery: notices that could not be saved to disk (shown from memory).
#[derive(Debug, Default)]
pub struct CleanupReport {
    pub unsaved_notices: Vec<RecoveryNotice>,
}

/// Finish or undo a restore interrupted by a crash, using the journal. Data is deleted only
/// when the state is proven:
/// - live db carries the journal's restore id (committed): keep the restored `files/`; the old
///   dir (pre-restore files) is moved to a `recovery-*` folder.
/// - live db readable and lacks the id (not committed): if the old dir is still set aside,
///   the live `files/` is provably the restored copy, so it is deleted and the old dir put
///   back; if the journal says there was no old dir, `files/` is moved to a `recovery-*`
///   folder; otherwise `files/` is the user's own and is left alone.
/// - journal unparseable or db unreadable after waiting out a lock (unknown): change no
///   decision. `files/`, every `.files-old-*` and the journal are moved together into a
///   `recovery-*` folder and the app starts with an empty `files/`.
///
/// If any step fails the journal is kept, so the next start retries. Every path that moves
/// files, or leaves work for a retry, leaves a [`RecoveryNotice`].
fn recover_journal(data_dir: &Path, busy: Duration, unsaved: &mut Vec<RecoveryNotice>) {
    let path = data_dir.join(JOURNAL);
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let files = data_dir.join("files");
    let files_dir = files.display().to_string();
    let j: Result<Journal, String> = serde_json::from_slice(&bytes).map_err(|e| e.to_string());
    let state = j
        .as_ref()
        .map_err(|e| format!("restore journal is unreadable: {e}"))
        .and_then(|j| {
            live_restore_id(data_dir, busy)
                .map(|id| id.as_deref() == Some(j.id.as_str()))
                .map_err(|e| format!("database could not be read: {e}"))
        });
    let committed = match state {
        Err(reason) => {
            quarantine(data_dir, &path, j.ok(), reason, unsaved);
            return;
        }
        Ok(c) => c,
    };
    let j = j.expect("state is Ok only when the journal parsed");
    let old = j.old.as_ref().map(|n| data_dir.join(n));
    let mut moved: Option<PathBuf> = None;
    let mut failure: Option<String> = None;
    if committed {
        if let Some(old) = old.as_ref().filter(|o| o.exists()) {
            match move_to_recovery(data_dir, old, "files-before-restore") {
                Ok(dest) => moved = Some(dest),
                Err(e) => failure = Some(format!("could not move the old attachments: {e}")),
            }
        }
    } else {
        let old_exists = old.as_ref().is_some_and(|o| o.exists());
        if j.quarantined && files.exists() {
            // An earlier start quarantined and left an empty files/: anything in it now may be
            // the user's new attachments. Never delete: move it aside.
            match move_to_recovery(data_dir, &files, "files-added-after-recovery") {
                Ok(dest) => moved = Some(dest),
                Err(e) => failure = Some(format!("could not move the attachments aside: {e}")),
            }
        } else if old_exists && files.exists() {
            // Provably the restored copy from the backup: safe to delete.
            let trash = data_dir.join(format!(".restore-trash-{}", unique_suffix()));
            match rename_retry(&files, &trash) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&trash);
                }
                Err(e) => {
                    failure = Some(format!("could not set aside the restored attachments: {e}"))
                }
            }
        } else if j.old.is_none() && files.exists() {
            // There was no files/ before; this one came from the restore, or from the
            // user after it. Never delete: move it aside.
            match move_to_recovery(data_dir, &files, "files-from-interrupted-restore") {
                Ok(dest) => moved = Some(dest),
                Err(e) => failure = Some(format!("could not move the attachments aside: {e}")),
            }
        }
        // (old recorded but already gone: files/ was never swapped, or was put back.)
        if failure.is_none() {
            if let Some(old) = old.as_ref().filter(|o| o.exists()) {
                if let Err(e) = rename_retry(old, &files) {
                    failure = Some(format!("could not put your attachments back: {e}"));
                }
            }
        }
    }
    sync_dir(data_dir);
    if failure.is_none() {
        if let Err(e) = remove_journal(data_dir) {
            eprintln!("coAuthor: could not remove the restore journal: {e}");
        }
    }
    if moved.is_some() || failure.is_some() {
        let reason = match &failure {
            Some(f) => format!("a restore was interrupted and recovery could not finish ({f})"),
            None => "a restore was interrupted".to_string(),
        };
        notify(
            data_dir,
            RecoveryNotice {
                folder: moved
                    .as_ref()
                    .and_then(|m| m.parent())
                    .map(|p| p.display().to_string()),
                moved: moved
                    .iter()
                    .filter_map(|m| m.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .collect(),
                snapshot: j.snapshot.clone(),
                files_dir,
                reason,
                retry_pending: failure.is_some(),
                save_error: None,
                id: String::new(),
                corrupt_file: None,
            },
            unsaved,
        );
    }
}

/// Unknown state: move `files/`, all `.files-old-*` and the journal into one recovery folder
/// (deleting nothing) and leave a notice listing only what was really moved. Leaves an empty
/// `files/` so the app works. If the journal can't be moved it stays, and the next start
/// retries.
fn quarantine(
    data_dir: &Path,
    journal: &Path,
    parsed: Option<Journal>,
    reason: String,
    unsaved: &mut Vec<RecoveryNotice>,
) {
    let files = data_dir.join("files");
    let files_dir = files.display().to_string();
    let snapshot = parsed.as_ref().and_then(|j| j.snapshot.clone());
    let dir = data_dir.join(format!("recovery-{}", unique_suffix()));
    let mut moved = Vec::new();
    let mut failures = Vec::new();
    // Mark the journal first: if it is kept after this, a later start must never treat the
    // (new, empty) files/ as the restored copy and delete it.
    let marked = match parsed {
        Some(mut j) if !j.quarantined => {
            j.quarantined = true;
            write_journal(data_dir, &j)
        }
        _ => Ok(()),
    };
    if let Err(e) = marked {
        failures.push(format!("could not update the restore journal: {e}"));
    } else if let Err(e) = std::fs::create_dir_all(&dir) {
        // Can't move anything safely: leave everything (journal included) in place.
        failures.push(format!("could not create a recovery folder: {e}"));
    } else {
        if files.exists() {
            match rename_retry(&files, &dir.join("files")) {
                Ok(()) => moved.push("files".to_string()),
                Err(e) => failures.push(format!("could not move files: {e}")),
            }
        }
        if let Ok(rd) = std::fs::read_dir(data_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with(".files-old-") {
                    let label = name.trim_start_matches('.').to_string();
                    match rename_retry(&e.path(), &dir.join(&label)) {
                        Ok(()) => moved.push(label),
                        Err(err) => failures.push(format!("could not move {name}: {err}")),
                    }
                }
            }
        }
        // The journal only moves once nothing it refers to is left behind.
        if failures.is_empty() {
            if let Err(e) = rename_retry(journal, &dir.join("restore-journal")) {
                failures.push(format!("could not move the restore journal: {e}"));
            }
        }
        if moved.is_empty() && failures.is_empty() {
            moved.push("restore-journal".to_string());
        }
        if moved.is_empty() {
            let _ = std::fs::remove_dir(&dir); // nothing went in
        }
    }
    if !files.exists() && marked_ok(&failures) {
        let _ = std::fs::create_dir_all(&files);
    }
    sync_dir(data_dir);
    let retry_pending = !failures.is_empty();
    let reason = if retry_pending {
        format!(
            "{reason}; recovery could not finish ({})",
            failures.join("; ")
        )
    } else {
        reason
    };
    notify(
        data_dir,
        RecoveryNotice {
            folder: (!moved.is_empty()).then(|| dir.display().to_string()),
            moved,
            snapshot,
            files_dir,
            reason,
            retry_pending,
            save_error: None,
            id: String::new(),
            corrupt_file: None,
        },
        unsaved,
    );
}

fn marked_ok(failures: &[String]) -> bool {
    !failures
        .iter()
        .any(|f| f.starts_with("could not update the restore journal"))
}

/// Recover from a crash mid-restore (see [`recover_journal`]) and remove temp dirs/files left
/// by a crash mid-backup or mid-restore. Call at startup, before opening the [`Store`].
/// Without a journal, a `.files-old-*` dir is put back if `files/` is missing, otherwise moved
/// to a `recovery-*` folder. Only temp artifacts this module created are deleted.
pub fn cleanup_temp(data_dir: &Path) -> CleanupReport {
    cleanup_temp_with(data_dir, RECOVERY_BUSY_TIMEOUT)
}

fn cleanup_temp_with(data_dir: &Path, busy: Duration) -> CleanupReport {
    let mut unsaved = Vec::new();
    recover_journal(data_dir, busy, &mut unsaved);
    // A journal still present means recovery could not act; then touch nothing it refers to.
    let journal_pending = data_dir.join(JOURNAL).exists();
    let files = data_dir.join("files");
    let Ok(rd) = std::fs::read_dir(data_dir) else {
        return CleanupReport {
            unsaved_notices: unsaved,
        };
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !TMP_PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        let path = e.path();
        if name.starts_with(".files-old-") || name == JOURNAL {
            if journal_pending {
                continue;
            }
            // User data moved aside by a restore: put it back, or keep it in a recovery folder.
            if !files.exists() {
                let _ = rename_retry(&path, &files);
            } else {
                match move_to_recovery(data_dir, &path, "files-before-restore") {
                    Ok(dest) => notify(
                        data_dir,
                        RecoveryNotice {
                            folder: dest.parent().map(|p| p.display().to_string()),
                            moved: vec!["files-before-restore".to_string()],
                            snapshot: None,
                            files_dir: files.display().to_string(),
                            reason: "attachments set aside by an earlier restore were found"
                                .to_string(),
                            retry_pending: false,
                            save_error: None,
                            id: String::new(),
                            corrupt_file: None,
                        },
                        &mut unsaved,
                    ),
                    Err(err) => eprintln!("coAuthor: could not move {name} aside: {err}"),
                }
            }
        } else if path.is_dir() {
            // Temp artifacts we created (.backup-*, .restore-* staging/trash dirs).
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(rd) = std::fs::read_dir(data_dir.join("backups")) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().ends_with(".part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    CleanupReport {
        unsaved_notices: unsaved,
    }
}

/// Relative paths (with `/` separators) of all regular files under `root`.
fn list_files(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            let path = entry.path();
            if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .expect("walked path under root")
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((rel, path));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut h = Sha256::new();
    std::io::copy(&mut File::open(path)?, &mut h)?;
    Ok(hex(&h.finalize()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Move `part` to `dest` without ever replacing an existing file.
fn publish_no_clobber(part: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(part, dest) {
        Ok(()) => std::fs::remove_file(part),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => {
            // Filesystem without hard links: exclusive create + copy.
            // Reserve the name, then fill it; on failure remove it so no partial file remains
            // under the real name.
            let res = (|| {
                let mut out = OpenOptions::new().write(true).create_new(true).open(dest)?;
                std::io::copy(&mut File::open(part)?, &mut out)?;
                out.sync_all()
            })();
            match res {
                Ok(()) => std::fs::remove_file(part),
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        let _ = std::fs::remove_file(dest);
                    }
                    Err(e)
                }
            }
        }
    }
}

/// Write a full backup to `dest` (which must not exist) and return its manifest.
pub fn create_backup(
    store: &Store,
    app_version: &str,
    dest: &Path,
) -> Result<Manifest, BackupError> {
    create_backup_to(store, app_version, dest, false)
}

/// Like [`create_backup`]; with `replace` (the user confirmed Replace in the save dialog) an
/// existing `dest` is atomically replaced: the archive is fully written to a temp file next to
/// it and renamed over it, so `dest` is always either the old file or the complete new one.
pub fn create_backup_to(
    store: &Store,
    app_version: &str,
    dest: &Path,
    replace: bool,
) -> Result<Manifest, BackupError> {
    create_backup_inner(store, app_version, dest, replace, false)
}

/// [`create_backup_to`]; `fail_mid_write` (tests only) fails after part of the archive is on
/// disk, to prove a failed write never touches `dest`.
fn create_backup_inner(
    store: &Store,
    app_version: &str,
    dest: &Path,
    replace: bool,
    fail_mid_write: bool,
) -> Result<Manifest, BackupError> {
    if !replace && dest.exists() {
        return Err(BackupError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", dest.display()),
        )));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = tempfile::Builder::new()
        .prefix(".backup-")
        .tempdir_in(store.data_dir())?;
    let snap = tmp.path().join("snapshot.db");
    store.with_sql(|c| {
        c.execute("VACUUM INTO ?1", [snap.to_string_lossy()])
            .map(|_| ())
    })?;

    let files = list_files(&files_dir(store))?;
    let mut sha256 = BTreeMap::new();
    sha256.insert(DB_ENTRY.to_string(), hash_file(&snap)?);
    for (rel, path) in &files {
        sha256.insert(format!("{FILES_PREFIX}{rel}"), hash_file(path)?);
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        app_version: app_version.into(),
        schema_version: store.schema_version()?,
        created_at_unix: (now_ms() / 1000) as u64,
        files: files.iter().map(|(r, _)| r.clone()).collect(),
        sha256,
    };

    let part = dest.with_file_name(format!(
        "{}.{}.part",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        unique_suffix()
    ));
    let res = (|| -> Result<(), BackupError> {
        let mut zw = zip::ZipWriter::new(File::create(&part)?);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zw.start_file(MANIFEST_ENTRY, opts)?;
        zw.write_all(&serde_json::to_vec_pretty(&manifest).expect("manifest serializes"))?;
        zw.start_file(DB_ENTRY, opts)?;
        std::io::copy(&mut File::open(&snap)?, &mut zw)?;
        if fail_mid_write {
            return Err(BackupError::Io(std::io::Error::other(
                "injected write failure",
            )));
        }
        for (rel, path) in &files {
            zw.start_file(format!("{FILES_PREFIX}{rel}"), opts)?;
            std::io::copy(&mut File::open(path)?, &mut zw)?;
        }
        zw.finish()?.sync_all()?;
        if replace {
            rename_retry(&part, dest).map_err(|e| locked_target_error(e, dest))?;
        } else {
            publish_no_clobber(&part, dest)?;
        }
        sync_parent_dir(dest);
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    res.map(|_| manifest)
}

/// Make the rename durable (best effort; directories can't be synced this way on Windows).
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
use crate::save_copy::is_unc_like;

/// Check a backup destination picked in the native save dialog (opened by Rust, #73) and
/// return the real path to write. Refuses relative paths, `.`/`..` components, non-`.zip`
/// names, a missing folder, and anything that resolves (after canonicalizing the parent, so
/// symlinks and junctions are followed) into one of `data_dirs` (the `backups` folder
/// included), a destination that is itself a link, and UNC / admin-share paths. Uses the
/// same shared check as `save_manuscript_copy` (#65): [`crate::save_copy::check_write_dest`].
pub fn check_backup_dest(
    store: &Store,
    data_dirs: &[PathBuf],
    dest: &Path,
) -> Result<PathBuf, BackupError> {
    let mut roots = vec![store.data_dir().to_path_buf()];
    roots.extend(data_dirs.iter().cloned());
    Ok(crate::save_copy::check_write_dest(
        &roots, dest, "zip", "backup",
    )?)
}

/// Write a backup to a destination the user picked in the save dialog (which already
/// confirmed Replace), after [`check_backup_dest`]. Returns the real path written.
pub fn create_backup_checked(
    store: &Store,
    app_version: &str,
    data_dirs: &[PathBuf],
    dest: &Path,
) -> Result<PathBuf, BackupError> {
    let real = check_backup_dest(store, data_dirs, dest)?;
    create_backup_to(store, app_version, &real, true)?;
    Ok(real)
}

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Safe relative path for an archive entry: no absolute paths, `..`, drive prefixes,
/// backslashes, Windows reserved device names, or segments ending in '.' or ' '.
fn safe_rel(name: &str) -> Result<PathBuf, BackupError> {
    let bad = || invalid(format!("unsafe entry name {name:?}"));
    if name.is_empty() || name.contains('\\') || name.contains(':') || name.contains('\0') {
        return Err(bad());
    }
    let mut out = PathBuf::new();
    for seg in name.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.ends_with('.') || seg.ends_with(' ') {
            return Err(bad());
        }
        let stem = seg.split('.').next().unwrap_or("").trim_end();
        if WINDOWS_RESERVED
            .iter()
            .any(|r| r.eq_ignore_ascii_case(stem))
        {
            return Err(bad());
        }
        match Path::new(seg).components().next() {
            Some(Component::Normal(_)) => out.push(seg),
            _ => return Err(bad()),
        }
    }
    Ok(out)
}

struct Staged {
    _dir: tempfile::TempDir,
    db: PathBuf,
    files: PathBuf,
    manifest: Manifest,
}

/// Unpack and validate an archive into a temp dir inside the data dir.
fn stage(store: &Store, src: &Path) -> Result<Staged, BackupError> {
    let mut za = zip::ZipArchive::new(File::open(src)?)
        .map_err(|e| invalid(format!("not a zip archive: {e}")))?;

    let mut names = HashSet::new();
    for i in 0..za.len() {
        let e = za.by_index_raw(i)?;
        if e.encrypted() {
            return Err(invalid("encrypted entries are not supported"));
        }
        if !names.insert(e.name().to_string()) {
            return Err(invalid(format!("duplicate entry {:?}", e.name())));
        }
    }

    let manifest: Manifest = {
        let e = za
            .by_name(MANIFEST_ENTRY)
            .map_err(|_| invalid("missing manifest.json"))?;
        let mut buf = String::new();
        e.take(MAX_MANIFEST_BYTES).read_to_string(&mut buf)?;
        serde_json::from_str(&buf).map_err(|e| invalid(format!("bad manifest: {e}")))?
    };
    if manifest.format != FORMAT {
        return Err(invalid("not a coAuthor backup"));
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(invalid("backup was made by a newer coAuthor"));
    }
    let current = store.schema_version()?;
    if manifest.schema_version > current {
        return Err(invalid(format!(
            "backup schema v{} is newer than this build (v{current})",
            manifest.schema_version
        )));
    }
    // Manifest must describe exactly the archive's entries.
    let mut expected: HashSet<String> = manifest
        .files
        .iter()
        .map(|f| format!("{FILES_PREFIX}{f}"))
        .collect();
    expected.insert(DB_ENTRY.to_string());
    let hashed: HashSet<String> = manifest.sha256.keys().cloned().collect();
    let actual: HashSet<String> = names
        .iter()
        .filter(|n| *n != MANIFEST_ENTRY && !n.ends_with('/'))
        .cloned()
        .collect();
    if expected != actual || hashed != actual {
        return Err(invalid("manifest does not match archive entries"));
    }

    let dir = tempfile::Builder::new()
        .prefix(".restore-")
        .tempdir_in(store.data_dir())?;
    let db = dir.path().join("restore.db");
    let files = dir.path().join("files");
    std::fs::create_dir_all(&files)?;
    let mut total: u64 = 0;
    for i in 0..za.len() {
        let mut e = za.by_index(i)?;
        let name = e.name().to_string();
        if e.is_dir() || name == MANIFEST_ENTRY {
            continue;
        }
        let target = if name == DB_ENTRY {
            db.clone()
        } else if let Some(rel) = name.strip_prefix(FILES_PREFIX) {
            let t = files.join(safe_rel(rel)?);
            if let Some(p) = t.parent() {
                std::fs::create_dir_all(p)?;
            }
            t
        } else {
            return Err(invalid(format!("unexpected entry {name:?}")));
        };
        let declared = e.size();
        if total.saturating_add(declared) > MAX_TOTAL_BYTES {
            return Err(invalid("archive too large"));
        }
        let mut out = File::create(&target)?;
        let mut h = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut n: u64 = 0;
        // Read at most declared+1 bytes so a lying header is caught without bombing the disk.
        let mut r = (&mut e).take(declared + 1);
        loop {
            let k = r.read(&mut buf)?;
            if k == 0 {
                break;
            }
            n += k as u64;
            if n > declared {
                return Err(invalid(format!("size mismatch in {name:?}")));
            }
            h.update(&buf[..k]);
            out.write_all(&buf[..k])?;
        }
        if n != declared {
            return Err(invalid(format!("size mismatch in {name:?}")));
        }
        total += n;
        if manifest.sha256.get(&name) != Some(&hex(&h.finalize())) {
            return Err(invalid(format!("checksum mismatch in {name:?}")));
        }
    }

    {
        let conn = Connection::open(&db).map_err(|e| invalid(format!("database: {e}")))?;
        let check: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| invalid(format!("database: {e}")))?;
        if check != "ok" {
            return Err(invalid(format!("database integrity check failed: {check}")));
        }
        let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if v != manifest.schema_version {
            return Err(invalid("manifest schema version does not match database"));
        }
    }
    Ok(Staged {
        _dir: dir,
        db,
        files,
        manifest,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// Agent tokens revoked by this restore (all of them). Agents are kept; the user must mint
    /// new tokens. The UI shows this once.
    pub tokens_revoked: u64,
    pub manifest: Manifest,
    /// Snapshot of the state that was replaced; restore it to undo.
    pub pre_restore_snapshot: String,
}

/// Label of the restore dialog's file filter (#83).
pub const RESTORE_FILTER_NAME: &str = "swarmDraft backup";
/// UI error code: the chosen file is not a backup (nothing was changed).
pub const NOT_A_BACKUP: &str = "not-a-backup";
/// UI error code: the restore did not finish.
pub const RESTORE_FAILED: &str = "restore-failed";

/// What the window learns about a restore: no paths, no raw errors (#83).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub tokens_revoked: u64,
}

/// Restore from a file the user picked in the native dialog. The file is validated by its
/// manifest format id and contents (see `stage`), never by its name or extension. Details
/// and paths are logged; the caller gets only a UI code.
pub fn restore_picked(
    store: &Store,
    app_version: &str,
    src: &Path,
) -> Result<RestoreOutcome, &'static str> {
    match restore_backup(store, app_version, src) {
        Ok(r) => {
            eprintln!(
                "restore: restored {} (pre-restore snapshot {})",
                src.display(),
                r.pre_restore_snapshot
            );
            Ok(RestoreOutcome {
                tokens_revoked: r.tokens_revoked,
            })
        }
        Err(e) => {
            eprintln!("restore: {} failed: {e}", src.display());
            Err(match e {
                BackupError::Invalid(_) => NOT_A_BACKUP,
                _ => RESTORE_FAILED,
            })
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Test hook: renames whose source path contains any of these fail.
    static FAIL_RENAME: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Test hook: saving the recovery notice fails.
    static FAIL_NOTICE_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test hook: force a failure at a given step of [`apply`].
#[derive(Debug, Clone, Copy, PartialEq)]
enum FailAt {
    None,
    AfterDbSwap,
    AfterFilesSwap,
    AfterPrepare,
    /// Simulated process death right after the given step: return immediately with no
    /// in-process undo or rollback, leaving disk exactly as a crash would.
    Crash(Step),
}

/// Steps of [`apply`], in order, for crash injection.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum Step {
    Journal,
    OldMovedAside,
    FilesSwapped,
    Prepared,
    DbCommitted,
    OldRemoved,
}

/// Validate `src`, snapshot current state, then replace the database and files with the backup.
/// Nothing is modified unless validation and the pre-restore snapshot both succeed; any later
/// error rolls back from that snapshot.
pub fn restore_backup(
    store: &Store,
    app_version: &str,
    src: &Path,
) -> Result<RestoreReport, BackupError> {
    restore_with(store, app_version, src, FailAt::None)
}

fn restore_with(
    store: &Store,
    app_version: &str,
    src: &Path,
    fail: FailAt,
) -> Result<RestoreReport, BackupError> {
    let staged = stage(store, src)?;
    let snapshot = backups_dir(store).join(format!("pre-restore-{}.zip", unique_suffix()));
    create_backup(store, app_version, &snapshot)?;

    let tokens_revoked = match apply(store, &staged, fail, true, &snapshot) {
        Ok(n) => {
            // The token table was replaced underneath the MCP auth cache; drop it so a
            // cached token from before the restore must authenticate against the new db.
            store.clear_token_cache();
            n
        }
        Err(err) if matches!(fail, FailAt::Crash(_)) => return Err(err),
        Err(err) => {
            drop(staged);
            // Rollback returns to the pre-restore state exactly, so tokens valid then stay valid.
            let rb = stage(store, &snapshot)
                .and_then(|s| apply(store, &s, FailAt::None, false, &snapshot));
            store.clear_token_cache();
            return Err(match rb {
                Ok(_) => BackupError::RolledBack(err.to_string()),
                Err(e2) => BackupError::RollbackFailed(
                    err.to_string(),
                    e2.to_string(),
                    snapshot.display().to_string(),
                ),
            });
        }
    };
    Ok(RestoreReport {
        tokens_revoked,
        manifest: staged.manifest,
        pre_restore_snapshot: snapshot.display().to_string(),
    })
}

/// Friendlier error when the Save As target is open in another program on Windows
/// (ERROR_SHARING_VIOLATION 32 / ERROR_LOCK_VIOLATION 33); other errors pass through.
fn locked_target_error(e: std::io::Error, dest: &Path) -> std::io::Error {
    // On Windows, replacing a file another program holds open fails with 32/33, or with 5
    // (access denied) when the replace is a rename. Raw 5 means EIO elsewhere, so it is only
    // mapped on Windows.
    let locked = match e.raw_os_error() {
        Some(32) | Some(33) => true,
        Some(5) => cfg!(windows) && dest.exists(),
        _ => false,
    };
    if locked {
        std::io::Error::new(
            e.kind(),
            format!(
                "{} is open in another program. Close it (or choose a different name) and try again.",
                dest.display()
            ),
        )
    } else {
        e
    }
}

/// Windows ERROR_SHARING_VIOLATION (32) or ERROR_ACCESS_DENIED (5): transient locks held by
/// antivirus/indexers. Never retried on other platforms.
fn is_sharing_violation(e: &std::io::Error) -> bool {
    cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(5))
}

/// Rename with short retries: on Windows, antivirus/indexers briefly lock fresh files.
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_RENAME.with(|f| {
        f.borrow()
            .iter()
            .any(|s| from.to_string_lossy().contains(s.as_str()))
    }) {
        return Err(std::io::Error::other("simulated rename failure"));
    }
    let mut delay = std::time::Duration::from_millis(20);
    for attempt in 0.. {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 5 && is_sharing_violation(&e) => {
                std::thread::sleep(delay);
                delay *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Swap staged files + db into place, crash-safely:
/// 1. write + fsync a journal (restore id, old dir name);
/// 2. move `files/` aside to `.files-old-*` and the staged files in (same-volume renames);
/// 3. migrate the staged db, stamp the restore id into it and (for user restores) revoke all
///    agent tokens in it;
/// 4. copy it into the live connection with the SQLite backup API (the commit point);
/// 5. remove the old dir, then the journal.
///
/// A crash anywhere is repaired at startup by [`cleanup_temp`]: the live db carries the
/// restore id iff step 4 committed. In-process errors are undone here. Returns the number of
/// tokens revoked.
fn apply(
    store: &Store,
    staged: &Staged,
    fail: FailAt,
    revoke_tokens: bool,
    snapshot: &Path,
) -> Result<u64, BackupError> {
    let crash = |s: Step| -> Result<(), BackupError> {
        if fail == FailAt::Crash(s) {
            return Err(BackupError::Io(std::io::Error::other("simulated crash")));
        }
        Ok(())
    };
    let dir = store.data_dir();
    let live = files_dir(store);
    let id = unique_suffix();
    let old_name = format!(".files-old-{id}");
    let old = dir.join(&old_name);
    let had_old = live.exists();
    write_journal(
        dir,
        &Journal {
            id: id.clone(),
            old: had_old.then(|| old_name.clone()),
            snapshot: Some(snapshot.display().to_string()),
            quarantined: false,
        },
    )?;
    crash(Step::Journal)?;
    let undo_files = || {
        let trash = dir.join(format!(".restore-trash-{}", unique_suffix()));
        if live.exists()
            && (had_old && old.exists() || !had_old)
            && rename_retry(&live, &trash).is_ok()
        {
            let _ = std::fs::remove_dir_all(&trash);
        }
        if had_old && old.exists() {
            let _ = rename_retry(&old, &live);
        }
        // The journal stays until the caller's db rollback has finished.
    };
    if had_old {
        if let Err(e) = rename_retry(&live, &old) {
            let _ = remove_journal(dir);
            return Err(e.into());
        }
    }
    crash(Step::OldMovedAside)?;
    if let Err(e) = rename_retry(&staged.files, &live) {
        undo_files();
        return Err(e.into());
    }
    sync_dir(dir);
    crash(Step::FilesSwapped)?;
    let db_step = (|| -> Result<u64, BackupError> {
        if fail == FailAt::AfterFilesSwap {
            return Err(BackupError::Io(std::io::Error::other("forced failure")));
        }
        // Revoke in the staged file first, so the swapped-in db never holds live tokens.
        let n = Store::prepare_restore_db(&staged.db, revoke_tokens, &id)?;
        crash(Step::Prepared)?;
        if fail == FailAt::AfterPrepare {
            return Err(BackupError::Io(std::io::Error::other("forced failure")));
        }
        store.restore_db_from(&staged.db)?;
        crash(Step::DbCommitted)?;
        if fail == FailAt::AfterDbSwap {
            return Err(BackupError::Io(std::io::Error::other("forced failure")));
        }
        Ok(n)
    })();
    match db_step {
        Ok(n) => {
            if had_old {
                let _ = std::fs::remove_dir_all(&old);
            }
            crash(Step::OldRemoved)?;
            remove_journal(dir)?;
            Ok(n)
        }
        Err(e) if matches!(fail, FailAt::Crash(_)) => Err(e),
        Err(e) => {
            undo_files();
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        store
            .with_sql(|c| {
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, body TEXT, blob BLOB);
                     INSERT INTO t (body, blob) VALUES ('Synthetic chapter one.', x'0102ff');
                     INSERT INTO app_meta VALUES ('k', 'v1');",
                )
            })
            .unwrap();
        let img = tmp.path().join("files").join("images");
        std::fs::create_dir_all(&img).unwrap();
        std::fs::write(img.join("cover.png"), b"\x89PNGfake").unwrap();
        (tmp, store)
    }

    fn meta(store: &Store) -> String {
        store
            .with_sql(|c| c.query_row("SELECT value FROM app_meta WHERE key='k'", [], |r| r.get(0)))
            .unwrap()
    }

    #[test]
    fn round_trip_restores_db_and_files() {
        let (tmp, store) = seeded();
        let zip = tmp.path().join("out").join("b.zip");
        let m = create_backup(&store, "0.1.0", &zip).unwrap();
        assert_eq!(m.files, vec!["images/cover.png".to_string()]);
        assert!(!zip.with_extension("zip.part").exists());

        store
            .with_sql(|c| c.execute_batch("UPDATE app_meta SET value='v2'; DELETE FROM t;"))
            .unwrap();
        std::fs::remove_dir_all(tmp.path().join("files")).unwrap();
        std::fs::write(tmp.path().join("files-marker"), b"x").unwrap();

        let r = restore_backup(&store, "0.1.0", &zip).unwrap();
        assert_eq!(meta(&store), "v1");
        let (body, blob): (String, Vec<u8>) = store
            .with_sql(|c| {
                c.query_row("SELECT body, blob FROM t", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
            })
            .unwrap();
        assert_eq!(body, "Synthetic chapter one.");
        assert_eq!(blob, vec![1, 2, 255]);
        assert_eq!(
            std::fs::read(tmp.path().join("files/images/cover.png")).unwrap(),
            b"\x89PNGfake"
        );
        // The pre-restore snapshot captures the replaced state and can itself be restored.
        let snap = PathBuf::from(&r.pre_restore_snapshot);
        assert!(snap.exists());
        restore_backup(&store, "0.1.0", &snap).unwrap();
        assert_eq!(meta(&store), "v2");
        // No temp dirs left behind.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn rejects_garbage_without_touching_state() {
        let (tmp, store) = seeded();
        let bad = tmp.path().join("bad.zip");
        std::fs::write(&bad, b"not a zip").unwrap();
        assert!(matches!(
            restore_backup(&store, "0", &bad),
            Err(BackupError::Invalid(_))
        ));
        assert_eq!(meta(&store), "v1");
        assert!(
            !tmp.path().join("backups").exists(),
            "no snapshot on invalid input"
        );
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zw = zip::ZipWriter::new(File::create(path).unwrap());
        for (n, b) in entries {
            zw.start_file(*n, SimpleFileOptions::default()).unwrap();
            zw.write_all(b).unwrap();
        }
        zw.finish().unwrap();
    }

    /// Manifest whose hashes and file list match `entries` exactly.
    fn manifest_for(schema: i64, entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut sha256 = BTreeMap::new();
        let mut files = vec![];
        for (n, b) in entries {
            sha256.insert(n.to_string(), hex(&Sha256::digest(b)));
            if let Some(f) = n.strip_prefix(FILES_PREFIX) {
                files.push(f.to_string());
            }
        }
        serde_json::to_vec(&Manifest {
            format: FORMAT.into(),
            format_version: 1,
            app_version: "0".into(),
            schema_version: schema,
            created_at_unix: 0,
            files,
            sha256,
        })
        .unwrap()
    }

    #[test]
    fn rejects_traversal_newer_schema_and_corrupt_db() {
        let (tmp, store) = seeded();
        let good = tmp.path().join("g.zip");
        create_backup(&store, "0", &good).unwrap();
        let mut db = Vec::new();
        zip::ZipArchive::new(File::open(&good).unwrap())
            .unwrap()
            .by_name(DB_ENTRY)
            .unwrap()
            .read_to_end(&mut db)
            .unwrap();
        let v = store.schema_version().unwrap();
        let with_db = |extra: Vec<(&'static str, Vec<u8>)>| {
            let mut e = vec![(DB_ENTRY, db.clone())];
            e.extend(extra);
            e
        };
        type Case<'a> = (&'a str, Vec<(&'a str, Vec<u8>)>);
        let mut cases: Vec<Case> = vec![];
        for (label, name) in [
            ("traversal", "files/../../evil"),
            ("backslash", "files/..\\evil"),
            ("drive", "files/C:/evil"),
            ("reserved", "files/img/CON.png"),
            ("reserved2", "files/nul"),
            ("trailing dot", "files/img./a.png"),
            ("trailing space", "files/a.png "),
        ] {
            let e = with_db(vec![(name, b"x".to_vec())]);
            let mut full = vec![(MANIFEST_ENTRY, manifest_for(v, &e))];
            full.extend(e);
            cases.push((label, full));
        }
        let e = with_db(vec![]);
        cases.push((
            "newer schema",
            vec![
                (MANIFEST_ENTRY, manifest_for(v + 1, &e)),
                (DB_ENTRY, db.clone()),
            ],
        ));
        let corrupt = vec![(DB_ENTRY, b"SQLite format 3\0garbage".to_vec())];
        cases.push((
            "corrupt db",
            vec![
                (MANIFEST_ENTRY, manifest_for(v, &corrupt)),
                corrupt[0].clone(),
            ],
        ));
        cases.push(("no db", vec![(MANIFEST_ENTRY, manifest_for(v, &[]))]));
        cases.push(("no manifest", vec![(DB_ENTRY, db.clone())]));
        cases.push((
            "bad hash",
            vec![
                (MANIFEST_ENTRY, manifest_for(v, &e)),
                (DB_ENTRY, b"tampered".to_vec()),
            ],
        ));
        let mut extra = vec![(MANIFEST_ENTRY, manifest_for(v, &e))];
        extra.extend(with_db(vec![("files/unlisted.png", b"x".to_vec())]));
        cases.push(("unlisted entry", extra));
        for (label, entries) in cases {
            let p = tmp.path().join(format!("{}.zip", label.replace(' ', "_")));
            let refs: Vec<(&str, &[u8])> =
                entries.iter().map(|(n, b)| (*n, b.as_slice())).collect();
            write_zip(&p, &refs);
            assert!(
                matches!(
                    restore_backup(&store, "0", &p),
                    Err(BackupError::Invalid(_))
                ),
                "{label} should be rejected"
            );
        }
        assert_eq!(meta(&store), "v1");
        assert!(!tmp.path().parent().unwrap().join("evil").exists());
    }

    #[test]
    fn safe_rel_accepts_nested() {
        assert_eq!(safe_rel("a/b.png").unwrap(), Path::new("a").join("b.png"));
        assert!(safe_rel("/abs").is_err());
    }

    #[test]
    fn names_are_unique_and_never_overwrite() {
        let (tmp, store) = seeded();
        let a = default_backup_path(&store);
        let b = default_backup_path(&store);
        assert_ne!(a, b);
        create_backup(&store, "0", &a).unwrap();
        let before = std::fs::read(&a).unwrap();
        assert!(create_backup(&store, "0", &a).is_err());
        assert_eq!(std::fs::read(&a).unwrap(), before);
        // Two restores back to back keep two distinct pre-restore snapshots.
        let r1 = restore_backup(&store, "0", &a).unwrap();
        let r2 = restore_backup(&store, "0", &a).unwrap();
        assert_ne!(r1.pre_restore_snapshot, r2.pre_restore_snapshot);
        assert!(Path::new(&r1.pre_restore_snapshot).exists());
        assert!(Path::new(&r2.pre_restore_snapshot).exists());
        let parts = std::fs::read_dir(tmp.path().join("backups"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part")
            })
            .count();
        assert_eq!(parts, 0);
    }

    #[test]
    fn forced_failure_rolls_back() {
        for at in [FailAt::AfterDbSwap, FailAt::AfterFilesSwap] {
            let (tmp, store) = seeded();
            let zip = tmp.path().join("b.zip");
            create_backup(&store, "0", &zip).unwrap();
            store
                .with_sql(|c| c.execute_batch("UPDATE app_meta SET value='v2';"))
                .unwrap();
            let img = tmp.path().join("files/images/cover.png");
            std::fs::write(&img, b"changed").unwrap();
            let err = restore_with(&store, "0", &zip, at).unwrap_err();
            assert!(matches!(err, BackupError::RolledBack(_)), "{at:?}: {err}");
            assert_eq!(meta(&store), "v2", "{at:?}");
            assert_eq!(std::fs::read(&img).unwrap(), b"changed", "{at:?}");
            let leftovers = std::fs::read_dir(tmp.path())
                .unwrap()
                .filter(|e| {
                    e.as_ref()
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with('.')
                })
                .count();
            assert_eq!(leftovers, 0, "{at:?}");
        }
    }

    #[test]
    fn cleanup_removes_temp_and_recovers_files() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join(".restore-abc/files")).unwrap();
        std::fs::create_dir_all(d.join(".backup-abc")).unwrap();
        std::fs::create_dir_all(d.join(".files-old-1")).unwrap();
        std::fs::write(d.join(".files-old-1/a.png"), b"a").unwrap();
        std::fs::create_dir_all(d.join("backups")).unwrap();
        std::fs::write(d.join("backups/x.zip.1.part"), b"").unwrap();
        std::fs::write(d.join("backups/keep.zip"), b"").unwrap();
        cleanup_temp(d);
        assert!(!d.join(".restore-abc").exists());
        assert!(!d.join(".backup-abc").exists());
        assert_eq!(std::fs::read(d.join("files/a.png")).unwrap(), b"a");
        assert!(!d.join("backups/x.zip.1.part").exists());
        assert!(d.join("backups/keep.zip").exists());
    }

    #[test]
    fn token_revoked_after_backup_stays_dead() {
        let (tmp, store) = seeded();
        let a = store.create_agent("Synthetic agent", "#3366ff").unwrap();
        let t = store.create_token(&a.id, None).unwrap();
        let zip = tmp.path().join("b.zip");
        create_backup(&store, "0", &zip).unwrap();
        store.revoke_token(&t.info.id).unwrap();
        assert!(store.authenticate(&t.token).unwrap().is_none());
        let r = restore_backup(&store, "0", &zip).unwrap();
        assert!(store.authenticate(&t.token).unwrap().is_none());
        assert!(r.tokens_revoked >= 1);
    }

    #[test]
    fn restore_revokes_all_tokens_and_keeps_agents() {
        let (tmp, store) = seeded();
        let a = store.create_agent("Agent A", "#112233").unwrap();
        let b = store.create_agent("Agent B", "#445566").unwrap();
        let ta = store.create_token(&a.id, None).unwrap();
        let tb = store.create_token(&b.id, None).unwrap();
        let zip = tmp.path().join("b.zip");
        create_backup(&store, "0", &zip).unwrap();
        let r = restore_backup(&store, "0", &zip).unwrap();
        assert_eq!(r.tokens_revoked, 2);
        assert!(store.authenticate(&ta.token).unwrap().is_none());
        assert!(store.authenticate(&tb.token).unwrap().is_none());
        let agents = store.list_agents().unwrap();
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().all(|x| x.revoked_at.is_none()));
        // Agents can get fresh tokens.
        let fresh = store.create_token(&a.id, None).unwrap();
        assert!(store.authenticate(&fresh.token).unwrap().is_some());
        // A second restore revokes again, including tokens minted after the first.
        let r2 = restore_backup(&store, "0", &zip).unwrap();
        assert_eq!(r2.tokens_revoked, 2);
        assert!(store.authenticate(&fresh.token).unwrap().is_none());
    }

    #[test]
    fn rollback_keeps_tokens_valid() {
        let (tmp, store) = seeded();
        let a = store.create_agent("Agent", "#000000").unwrap();
        let t = store.create_token(&a.id, None).unwrap();
        let zip = tmp.path().join("b.zip");
        create_backup(&store, "0", &zip).unwrap();
        assert!(restore_with(&store, "0", &zip, FailAt::AfterDbSwap).is_err());
        assert!(store.authenticate(&t.token).unwrap().is_some());
    }

    #[test]
    fn staged_db_has_all_tokens_revoked_before_swap() {
        let (tmp, store) = seeded();
        let a = store.create_agent("Agent", "#000000").unwrap();
        let t1 = store.create_token(&a.id, None).unwrap();
        let _t2 = store.create_token(&a.id, None).unwrap();
        let zip = tmp.path().join("b.zip");
        create_backup(&store, "0", &zip).unwrap();
        let staged = stage(&store, &zip).unwrap();
        let live_before = |p: &Path| -> i64 {
            rusqlite::Connection::open(p)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM agent_tokens WHERE revoked_at IS NULL",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(live_before(&staged.db), 2);
        let n = Store::prepare_restore_db(&staged.db, true, "rid-1").unwrap();
        assert_eq!(n, 2);
        // The file that will be swapped in already has every token revoked (durably, on disk)...
        assert_eq!(live_before(&staged.db), 0);
        // ...while the live db is untouched until the swap.
        assert!(store.authenticate(&t1.token).unwrap().is_some());
    }

    #[test]
    fn failure_after_prepare_rolls_back_with_tokens_valid() {
        let (tmp, store) = seeded();
        let a = store.create_agent("Agent", "#000000").unwrap();
        let t = store.create_token(&a.id, None).unwrap();
        let zip = tmp.path().join("b.zip");
        create_backup(&store, "0", &zip).unwrap();
        assert!(restore_with(&store, "0", &zip, FailAt::AfterPrepare).is_err());
        assert!(store.authenticate(&t.token).unwrap().is_some());
        assert_eq!(meta(&store), "v1");
    }

    #[test]
    fn replace_overwrites_atomically_only_when_confirmed() {
        let (tmp, store) = seeded();
        let dest = tmp.path().join("out.zip");
        std::fs::write(&dest, b"old").unwrap();
        assert!(create_backup(&store, "0", &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        create_backup_to(&store, "0", &dest, true).unwrap();
        assert!(stage(&store, &dest).is_ok());
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }

    // ---- Crash matrix (PM harness style: synthetic manuscript row + attachment, edit after
    // backup, then inject a crash at each step, "restart" and check recovery). ----

    fn crash_setup() -> (tempfile::TempDir, Store, PathBuf, crate::agents::NewToken) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        store
            .with_sql(|c| {
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS ms (id INTEGER PRIMARY KEY, body TEXT);
                     INSERT INTO ms (body) VALUES ('Mock chapter: the lighthouse keeper.');",
                )
            })
            .unwrap();
        let d = tmp.path().join("files/images");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("map.png"), b"orig").unwrap();
        let bk = tmp.path().join("b.zip");
        create_backup(&store, "0", &bk).unwrap();
        // Post-backup edits: these are the user's pre-restore state.
        store
            .with_sql(|c| c.execute_batch("UPDATE ms SET body='EDITED';"))
            .unwrap();
        std::fs::write(d.join("map.png"), b"edited").unwrap();
        std::fs::write(tmp.path().join("files/added.txt"), b"new attachment").unwrap();
        let a = store.create_agent("QA agent", "#112233").unwrap();
        let t = store.create_token(&a.id, None).unwrap();
        (tmp, store, bk, t)
    }

    fn ms_body(s: &Store) -> String {
        s.with_sql(|c| c.query_row("SELECT group_concat(body,'|') FROM ms", [], |r| r.get(0)))
            .unwrap()
    }

    #[test]
    fn crash_matrix_recovers_at_every_step() {
        use Step::*;
        // (crash point, whether the restore had committed)
        let cases = [
            (Journal, false),
            (OldMovedAside, false),
            (FilesSwapped, false),
            (Prepared, false),
            (DbCommitted, true),
            (OldRemoved, true),
        ];
        for (step, committed) in cases {
            let (tmp, store, bk, tok) = crash_setup();
            let d = tmp.path().to_path_buf();
            let err = restore_with(&store, "0", &bk, FailAt::Crash(step)).unwrap_err();
            assert!(
                err.to_string().contains("simulated crash"),
                "{step:?}: {err}"
            );
            assert!(
                d.join(JOURNAL).exists(),
                "{step:?}: journal must survive the crash"
            );
            // "Process dies": drop the store, then restart.
            drop(store);
            cleanup_temp(&d);
            let store = Store::open(&d).unwrap();

            let map = std::fs::read(d.join("files/images/map.png")).unwrap();
            let added = d.join("files/added.txt");
            if committed {
                assert_eq!(
                    ms_body(&store),
                    "Mock chapter: the lighthouse keeper.",
                    "{step:?}"
                );
                assert_eq!(map, b"orig", "{step:?}");
                assert!(!added.exists(), "{step:?}");
                assert!(
                    store.authenticate(&tok.token).unwrap().is_none(),
                    "{step:?}"
                );
            } else {
                assert_eq!(ms_body(&store), "EDITED", "{step:?}");
                assert_eq!(map, b"edited", "{step:?}: pre-restore attachments kept");
                assert_eq!(
                    std::fs::read(&added).unwrap(),
                    b"new attachment",
                    "{step:?}"
                );
                assert!(
                    store.authenticate(&tok.token).unwrap().is_some(),
                    "{step:?}"
                );
            }
            // No journal, no temp/old dirs left; data dir is clean.
            let dots: Vec<_> = std::fs::read_dir(&d)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with('.'))
                .collect();
            assert!(dots.is_empty(), "{step:?}: leftovers {dots:?}");
            // A later restore still works normally.
            restore_backup(&store, "0", &bk).unwrap();
            assert_eq!(
                ms_body(&store),
                "Mock chapter: the lighthouse keeper.",
                "{step:?}"
            );
        }
    }

    #[test]
    fn crash_matrix_without_existing_files_dir() {
        for (step, committed) in [
            (Step::OldMovedAside, false),
            (Step::FilesSwapped, false),
            (Step::DbCommitted, true),
        ] {
            let (tmp, store, bk, _) = crash_setup();
            let d = tmp.path().to_path_buf();
            std::fs::remove_dir_all(d.join("files")).unwrap();
            let _ = restore_with(&store, "0", &bk, FailAt::Crash(step)).unwrap_err();
            drop(store);
            cleanup_temp(&d);
            let _store = Store::open(&d).unwrap();
            assert_eq!(
                d.join("files/images/map.png").exists(),
                committed,
                "{step:?}"
            );
            assert!(!d.join(JOURNAL).exists());
        }
    }

    #[test]
    fn successful_restore_leaves_no_journal_and_stamps_id() {
        let (tmp, store, bk, _) = crash_setup();
        restore_backup(&store, "0", &bk).unwrap();
        assert!(!tmp.path().join(JOURNAL).exists());
        assert!(live_restore_id(tmp.path(), Duration::ZERO)
            .unwrap()
            .is_some());
    }

    #[test]
    fn locked_save_target_gets_friendly_error() {
        let dest = Path::new("C:\\Backups\\b.zip");
        for code in [32, 33] {
            let e = locked_target_error(std::io::Error::from_raw_os_error(code), dest);
            assert!(e.to_string().contains("open in another program"), "{code}");
        }
        let e = locked_target_error(std::io::Error::from_raw_os_error(2), dest);
        assert!(!e.to_string().contains("open in another program"));
    }

    fn recovery_dirs(d: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(d)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name().to_string_lossy().starts_with("recovery-") && e.path().is_dir()
            })
            .map(|e| e.path())
            .collect()
    }

    #[test]
    fn unknown_journal_without_old_moves_files_aside_never_deletes() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        std::fs::create_dir_all(d.join("files/images")).unwrap();
        std::fs::write(d.join("files/images/user.png"), b"user data").unwrap();
        std::fs::write(d.join(JOURNAL), br#"{"id":"never-committed","old":null}"#).unwrap();
        cleanup_temp(d);
        assert!(!d.join(JOURNAL).exists());
        let rec = recovery_dirs(d);
        assert_eq!(rec.len(), 1);
        assert_eq!(
            std::fs::read(rec[0].join("files-from-interrupted-restore/images/user.png")).unwrap(),
            b"user data"
        );
    }

    /// Every file under `root` with its contents, keyed by path relative to `root`.
    fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
        list_files(root)
            .unwrap()
            .into_iter()
            .map(|(r, p)| (r, std::fs::read(p).unwrap()))
            .collect()
    }

    /// Uncertain-state layout: live files/, a .files-old-* dir, and a journal.
    fn uncertain_layout(d: &Path, journal: &[u8]) {
        std::fs::create_dir_all(d.join("files/images")).unwrap();
        std::fs::write(d.join("files/images/live.png"), b"live").unwrap();
        std::fs::create_dir_all(d.join(".files-old-7")).unwrap();
        std::fs::write(d.join(".files-old-7/old.txt"), b"old").unwrap();
        std::fs::write(d.join(JOURNAL), journal).unwrap();
    }

    fn assert_quarantined(d: &Path, journal: &[u8], reason: &str) {
        let rec = recovery_dirs(d);
        assert_eq!(rec.len(), 1, "one recovery folder");
        let r = &rec[0];
        let mut want = BTreeMap::new();
        want.insert("files/images/live.png".to_string(), b"live".to_vec());
        want.insert("files-old-7/old.txt".to_string(), b"old".to_vec());
        want.insert("restore-journal".to_string(), journal.to_vec());
        assert_eq!(tree(r), want, "all data survives in the recovery folder");
        assert!(!d.join(JOURNAL).exists());
        assert!(!d.join(".files-old-7").exists());
        assert!(
            d.join("files").is_dir() && tree(&d.join("files")).is_empty(),
            "app usable"
        );
        let ns = read_recovery_notices(d);
        assert_eq!(ns.len(), 1, "{ns:?}");
        let n = &ns[0];
        assert_eq!(Path::new(n.folder.as_deref().unwrap()), r.as_path());
        let mut moved = n.moved.clone();
        moved.sort();
        assert_eq!(moved, vec!["files", "files-old-7"]);
        assert!(!n.retry_pending);
        assert!(n.reason.contains(reason), "{}", n.reason);
        assert_eq!(read_recovery_notices(d), ns, "reading does not clear");
        let ids: Vec<String> = read_recovery_notices(d).into_iter().map(|n| n.id).collect();
        dismiss_recovery_notices(d, &ids).unwrap();
        assert!(read_recovery_notices(d).is_empty(), "dismiss clears");
    }

    #[test]
    fn corrupt_journal_quarantines_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        uncertain_layout(d, b"{not json");
        cleanup_temp(d);
        assert_quarantined(d, b"{not json", "journal is unreadable");
        assert!(Store::open(d).is_ok());
    }

    #[test]
    fn unreadable_db_quarantines_everything_and_keeps_snapshot_path() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::write(
            d.join("coauthor.db"),
            b"this is not a sqlite database at all....",
        )
        .unwrap();
        let j = br#"{"id":"r1","old":".files-old-7","snapshot":"C:\\data\\backups\\pre-restore-1.zip"}"#;
        uncertain_layout(d, j);
        // Peek at the snapshot before the notice is consumed by assert_quarantined.
        cleanup_temp(d);
        let notice = read_recovery_notices(d).remove(0);
        assert_eq!(
            notice.snapshot.as_deref(),
            Some("C:\\data\\backups\\pre-restore-1.zip")
        );
        // The parsed journal is marked quarantined before anything moves.
        let mut marked: Journal = serde_json::from_slice(j).unwrap();
        marked.quarantined = true;
        let marked = serde_json::to_vec(&marked).unwrap();
        assert_quarantined(d, &marked, "database could not be read");
        assert!(
            live_restore_id(d, Duration::ZERO).is_err(),
            "read error is distinguished from a missing row"
        );
    }

    #[test]
    fn missing_row_is_ok_none_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        drop(Store::open(tmp.path()).unwrap());
        assert_eq!(live_restore_id(tmp.path(), Duration::ZERO).unwrap(), None);
    }

    #[test]
    fn pending_journal_keeps_files_old_in_cleanup() {
        // A journal that cannot even be read (here: a directory) leaves recovery unable to act;
        // cleanup_temp must then not delete or move any .files-old-* dir.
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join(JOURNAL)).unwrap();
        std::fs::create_dir_all(d.join("files")).unwrap();
        std::fs::create_dir_all(d.join(".files-old-3")).unwrap();
        std::fs::write(d.join(".files-old-3/keep.txt"), b"k").unwrap();
        cleanup_temp(d);
        assert_eq!(
            std::fs::read(d.join(".files-old-3/keep.txt")).unwrap(),
            b"k"
        );
        assert!(d.join(JOURNAL).exists());
        assert!(recovery_dirs(d).is_empty());
    }

    #[test]
    fn committed_recovery_keeps_old_files_in_recovery_folder() {
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        let _ = restore_with(&store, "0", &bk, FailAt::Crash(Step::DbCommitted)).unwrap_err();
        drop(store);
        cleanup_temp(&d);
        let rec = recovery_dirs(&d);
        assert_eq!(rec.len(), 1);
        assert_eq!(
            std::fs::read(rec[0].join("files-before-restore/added.txt")).unwrap(),
            b"new attachment"
        );
    }

    #[test]
    fn stray_old_dir_with_live_files_is_kept_in_recovery() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("files")).unwrap();
        std::fs::write(d.join("files/live.txt"), b"live").unwrap();
        std::fs::create_dir_all(d.join(".files-old-9")).unwrap();
        std::fs::write(d.join(".files-old-9/old.txt"), b"old").unwrap();
        cleanup_temp(d);
        assert_eq!(std::fs::read(d.join("files/live.txt")).unwrap(), b"live");
        let rec = recovery_dirs(d);
        assert_eq!(
            std::fs::read(rec[0].join("files-before-restore/old.txt")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn sharing_violation_detection_is_windows_only() {
        let e32 = std::io::Error::from_raw_os_error(32);
        let e5 = std::io::Error::from_raw_os_error(5);
        let e2 = std::io::Error::from_raw_os_error(2);
        assert_eq!(is_sharing_violation(&e32), cfg!(windows));
        assert_eq!(is_sharing_violation(&e5), cfg!(windows));
        assert!(!is_sharing_violation(&e2));
    }

    /// Open `p` with no sharing, as an indexer, antivirus or another program might.
    #[cfg(windows)]
    fn lock_exclusive(p: &Path) -> File {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new().read(true).share_mode(0).open(p).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn windows_rename_retries_through_transient_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.bin");
        let b = tmp.path().join("b.bin");
        std::fs::write(&a, b"x").unwrap();
        let lock = lock_exclusive(&a);
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            drop(lock);
        });
        rename_retry(&a, &b).unwrap();
        t.join().unwrap();
        assert!(b.exists() && !a.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_save_as_target_gets_friendly_error() {
        let (tmp, store) = seeded();
        let dest = tmp.path().join("locked.zip");
        std::fs::write(&dest, b"old").unwrap();
        let lock = lock_exclusive(&dest);
        let err = create_backup_to(&store, "0", &dest, true).unwrap_err();
        drop(lock);
        assert!(err.to_string().contains("open in another program"), "{err}");
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        let parts = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(parts, 0);
    }

    /// Hold an exclusive write lock on the live db, as another process might.
    fn lock_db(d: &Path) -> Connection {
        let c = Connection::open(d.join("coauthor.db")).unwrap();
        c.execute_batch(
            "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
             CREATE TABLE IF NOT EXISTS lk(x); INSERT INTO lk VALUES(1);",
        )
        .unwrap();
        c
    }

    fn release(c: Connection) {
        c.execute_batch("ROLLBACK;").unwrap();
        drop(c);
    }

    #[test]
    fn brief_db_lock_is_waited_out_and_recovery_is_normal() {
        for step in [Step::Prepared, Step::DbCommitted] {
            let (tmp, store, bk, t) = crash_setup();
            let d = tmp.path().to_path_buf();
            restore_with(&store, "0", &bk, FailAt::Crash(step)).unwrap_err();
            drop(store);
            let locker = lock_db(&d);
            let h = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                release(locker);
            });
            let report = cleanup_temp_with(&d, Duration::from_secs(10));
            h.join().unwrap();
            assert!(report.unsaved_notices.is_empty());
            assert!(!d.join(JOURNAL).exists(), "{step:?}");
            for n in read_recovery_notices(&d) {
                assert!(!n.reason.contains("database"), "{step:?}: {}", n.reason);
            }
            let store = Store::open(&d).unwrap();
            if step == Step::Prepared {
                // Not committed: the user's own state comes back, nothing quarantined.
                assert_eq!(ms_body(&store), "EDITED");
                assert_eq!(
                    std::fs::read(d.join("files/images/map.png")).unwrap(),
                    b"edited"
                );
                assert!(recovery_dirs(&d).is_empty());
                assert!(read_recovery_notices(&d).is_empty());
                assert!(store.authenticate(&t.token).unwrap().is_some());
            } else {
                // Committed: restored attachments stay in place.
                assert_eq!(
                    std::fs::read(d.join("files/images/map.png")).unwrap(),
                    b"orig"
                );
                assert!(store.authenticate(&t.token).unwrap().is_none());
            }
        }
    }

    #[test]
    fn persistent_db_lock_quarantines_after_the_timeout() {
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        restore_with(&store, "0", &bk, FailAt::Crash(Step::DbCommitted)).unwrap_err();
        drop(store);
        let locker = lock_db(&d);
        let start = Instant::now();
        cleanup_temp_with(&d, Duration::from_millis(300));
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "waited for the lock"
        );
        release(locker);
        let ns = read_recovery_notices(&d);
        assert_eq!(ns.len(), 1);
        assert!(
            ns[0].reason.contains("database could not be read"),
            "{}",
            ns[0].reason
        );
        let rec = recovery_dirs(&d);
        assert_eq!(rec.len(), 1);
        assert_eq!(
            std::fs::read(rec[0].join("files/images/map.png")).unwrap(),
            b"orig",
            "restored files kept"
        );
        assert!(!d.join(JOURNAL).exists());
    }

    /// Not-committed layout: restored files/ live, the user's files set aside, journal.
    fn uncommitted_layout(d: &Path) {
        drop(Store::open(d).unwrap());
        std::fs::create_dir_all(d.join("files")).unwrap();
        std::fs::write(d.join("files/restored.txt"), b"from backup").unwrap();
        std::fs::create_dir_all(d.join(".files-old-9")).unwrap();
        std::fs::write(d.join(".files-old-9/mine.txt"), b"user").unwrap();
        std::fs::write(d.join(JOURNAL), br#"{"id":"never","old":".files-old-9"}"#).unwrap();
    }

    fn set_fail_rename(v: &[&str]) {
        FAIL_RENAME.with(|f| *f.borrow_mut() = v.iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn uncommitted_double_failure_keeps_journal_and_notice_then_retries() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        uncommitted_layout(d);
        // Both the trash rename of files/ and putting the old folder back fail.
        set_fail_rename(&["files"]);
        cleanup_temp(d);
        set_fail_rename(&[]);
        assert!(d.join(JOURNAL).exists(), "journal kept for a retry");
        assert_eq!(
            std::fs::read(d.join(".files-old-9/mine.txt")).unwrap(),
            b"user"
        );
        assert_eq!(
            std::fs::read(d.join("files/restored.txt")).unwrap(),
            b"from backup"
        );
        let ns = read_recovery_notices(d);
        assert_eq!(ns.len(), 1);
        assert!(ns[0].retry_pending);
        assert!(
            ns[0].moved.is_empty() && ns[0].folder.is_none(),
            "nothing claimed moved"
        );
        // Next start: the retry finishes the job.
        cleanup_temp(d);
        assert!(!d.join(JOURNAL).exists());
        assert_eq!(tree(&d.join("files")).len(), 1);
        assert_eq!(std::fs::read(d.join("files/mine.txt")).unwrap(), b"user");
        assert!(!d.join(".files-old-9").exists());
    }

    #[test]
    fn uncommitted_failed_put_back_keeps_journal_and_notice() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        uncommitted_layout(d);
        set_fail_rename(&[".files-old-9"]);
        cleanup_temp(d);
        set_fail_rename(&[]);
        assert!(d.join(JOURNAL).exists(), "never no journal and no notice");
        assert!(read_recovery_notices(d)[0].retry_pending);
        assert_eq!(
            std::fs::read(d.join(".files-old-9/mine.txt")).unwrap(),
            b"user"
        );
        cleanup_temp(d);
        assert!(!d.join(JOURNAL).exists());
        assert_eq!(std::fs::read(d.join("files/mine.txt")).unwrap(), b"user");
    }

    #[test]
    fn notice_lists_only_what_was_really_moved() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        uncertain_layout(d, b"{not json");
        set_fail_rename(&[".files-old-7"]);
        cleanup_temp(d);
        set_fail_rename(&[]);
        let ns = read_recovery_notices(d);
        assert_eq!(ns.len(), 1);
        assert_eq!(ns[0].moved, vec!["files"]);
        assert!(ns[0].retry_pending);
        assert!(
            d.join(".files-old-7/old.txt").exists(),
            "not moved, not claimed"
        );
        assert!(
            d.join(JOURNAL).exists(),
            "journal stays while .files-old-7 is outside"
        );
        let rec = recovery_dirs(d);
        assert_eq!(rec.len(), 1);
        assert!(rec[0].join("files/images/live.png").exists());
    }

    #[test]
    fn failed_notice_write_is_reported_not_swallowed() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        uncertain_layout(d, b"{not json");
        FAIL_NOTICE_WRITE.with(|f| f.set(true));
        let report = cleanup_temp(d);
        FAIL_NOTICE_WRITE.with(|f| f.set(false));
        assert!(read_recovery_notices(d).is_empty());
        assert_eq!(report.unsaved_notices.len(), 1);
        let n = &report.unsaved_notices[0];
        assert!(n.save_error.as_deref().unwrap().contains("simulated"));
        assert!(n.folder.is_some(), "the move is still reported");
    }

    #[test]
    fn every_path_that_moves_files_leaves_a_notice() {
        // Committed crash: pre-restore files moved to a recovery folder.
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        restore_with(&store, "0", &bk, FailAt::Crash(Step::DbCommitted)).unwrap_err();
        drop(store);
        cleanup_temp(&d);
        let ns = read_recovery_notices(&d);
        assert_eq!(ns.len(), 1);
        assert_eq!(ns[0].moved, vec!["files-before-restore"]);
        assert!(ns[0].snapshot.is_some());
        assert!(Path::new(ns[0].folder.as_deref().unwrap())
            .join("files-before-restore/added.txt")
            .exists());

        // Journal with no old dir: files/ moved aside.
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        std::fs::create_dir_all(d.join("files")).unwrap();
        std::fs::write(d.join("files/u.txt"), b"u").unwrap();
        std::fs::write(d.join(JOURNAL), br#"{"id":"x","old":null}"#).unwrap();
        cleanup_temp(d);
        assert_eq!(
            read_recovery_notices(d)[0].moved,
            vec!["files-from-interrupted-restore"]
        );

        // Stray .files-old-* with live files/ and no journal.
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("files")).unwrap();
        std::fs::create_dir_all(d.join(".files-old-2")).unwrap();
        std::fs::write(d.join(".files-old-2/o.txt"), b"o").unwrap();
        cleanup_temp(d);
        assert_eq!(
            read_recovery_notices(d)[0].moved,
            vec!["files-before-restore"]
        );
    }

    #[test]
    fn quarantine_is_not_repeated_on_restart_before_dismiss() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        uncertain_layout(d, b"\x00\xffgarbage{{");
        cleanup_temp(d);
        let rec = recovery_dirs(d);
        cleanup_temp(d);
        assert_eq!(recovery_dirs(d), rec, "no new recovery folder on restart");
        assert_eq!(
            read_recovery_notices(d).len(),
            1,
            "notice kept until dismissed"
        );
        let ids: Vec<String> = read_recovery_notices(d).into_iter().map(|n| n.id).collect();
        dismiss_recovery_notices(d, &ids).unwrap();
        cleanup_temp(d);
        assert!(read_recovery_notices(d).is_empty());
        assert!(Store::open(d).is_ok());
    }

    #[test]
    fn clean_restore_and_save_as_leave_no_notice_or_leftovers() {
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        restore_backup(&store, "0", &bk).unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("My Book.zip");
        create_backup_to(&store, "0", &dest, false).unwrap();
        create_backup_to(&store, "0", &dest, true).unwrap();
        drop(store);
        cleanup_temp(&d);
        let bad: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with('.') || n.starts_with("recovery-") || n == RECOVERY_NOTICE)
            .collect();
        assert!(bad.is_empty(), "leftovers: {bad:?}");
        assert!(read_recovery_notices(&d).is_empty());
    }

    #[test]
    fn attachments_added_after_a_kept_quarantine_journal_are_never_deleted() {
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        // Restore crashes before the db commit: restored files/ live, user's in .files-old-*.
        restore_with(&store, "0", &bk, FailAt::Crash(Step::Prepared)).unwrap_err();
        drop(store);
        // Next start: db locked -> quarantine; moving .files-old-* fails -> journal kept.
        let locker = lock_db(&d);
        set_fail_rename(&[".files-old-"]);
        cleanup_temp_with(&d, Duration::from_millis(200));
        set_fail_rename(&[]);
        release(locker);
        let j: Journal = serde_json::from_slice(&std::fs::read(d.join(JOURNAL)).unwrap()).unwrap();
        assert!(j.quarantined, "journal marked");
        assert!(d.join("files").is_dir() && tree(&d.join("files")).is_empty());
        // The user adds an attachment.
        std::fs::write(d.join("files/new-chapter-art.png"), b"precious new").unwrap();
        // Following start: db readable, not committed. Must move aside, never delete.
        cleanup_temp(&d);
        assert!(!d.join(JOURNAL).exists());
        let found: Vec<_> = recovery_dirs(&d)
            .into_iter()
            .map(|r| r.join("files-added-after-recovery/new-chapter-art.png"))
            .filter(|p| p.exists())
            .collect();
        assert_eq!(found.len(), 1, "new attachment kept in a recovery folder");
        assert_eq!(std::fs::read(&found[0]).unwrap(), b"precious new");
        // The user's pre-restore files are back in place.
        assert_eq!(
            std::fs::read(d.join("files/images/map.png")).unwrap(),
            b"edited"
        );
        assert!(read_recovery_notices(&d)
            .iter()
            .any(|n| n.moved == vec!["files-added-after-recovery"]));
    }

    #[test]
    fn corrupt_notice_file_is_kept_aside_and_shown() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        drop(Store::open(d).unwrap());
        std::fs::write(d.join(RECOVERY_NOTICE), b"{ not json").unwrap();
        uncertain_layout(d, b"{bad journal");
        cleanup_temp(d);
        let ns = read_recovery_notices(d);
        assert_eq!(ns.len(), 2, "{ns:?}");
        let kept = ns
            .iter()
            .find_map(|n| n.corrupt_file.clone())
            .expect("points at it");
        assert!(kept.contains("recovery-notice.corrupt-"));
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not json",
            "never deleted"
        );
        assert!(ns
            .iter()
            .any(|n| n.reason.contains("journal is unreadable")));
        // Reading directly also preserves a corrupt file.
        std::fs::write(d.join(RECOVERY_NOTICE), b"\xff\xfe").unwrap();
        let ns = read_recovery_notices(d);
        assert_eq!(ns.len(), 1);
        let kept2 = ns[0].corrupt_file.clone().unwrap();
        assert_eq!(std::fs::read(kept2).unwrap(), b"\xff\xfe");
    }

    #[test]
    fn dismiss_removes_only_the_notices_shown() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        save_notice(d, &{
            let mut n = RecoveryNotice::new(d, "first".into());
            n.id = n.content_id();
            n
        })
        .unwrap();
        let shown: Vec<String> = read_recovery_notices(d).into_iter().map(|n| n.id).collect();
        // A second notice arrives after the UI read the first.
        let mut n2 = RecoveryNotice::new(d, "second".into());
        n2.id = n2.content_id();
        save_notice(d, &n2).unwrap();
        dismiss_recovery_notices(d, &shown).unwrap();
        let left = read_recovery_notices(d);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].reason, "second");
        dismiss_recovery_notices(d, &[left[0].id.clone()]).unwrap();
        assert!(!d.join(RECOVERY_NOTICE).exists());
    }

    #[test]
    fn default_wait_rides_out_a_multi_second_lock() {
        assert_eq!(RECOVERY_BUSY_TIMEOUT, Duration::from_secs(10));
        let (tmp, store, bk, _) = crash_setup();
        let d = tmp.path().to_path_buf();
        restore_with(&store, "0", &bk, FailAt::Crash(Step::Prepared)).unwrap_err();
        drop(store);
        let locker = lock_db(&d);
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            release(locker);
        });
        let start = Instant::now();
        cleanup_temp(&d); // the real default path
        h.join().unwrap();
        assert!(start.elapsed() >= Duration::from_secs(3));
        assert!(recovery_dirs(&d).is_empty(), "no quarantine");
        assert!(read_recovery_notices(&d).is_empty());
        assert_eq!(
            std::fs::read(d.join("files/images/map.png")).unwrap(),
            b"edited"
        );
    }
    // ---- #73: backend-chosen destination ----

    fn outside() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn checked_backup_writes_outside_data_dir() {
        let (_tmp, store) = seeded();
        let out = outside();
        let dest = out.path().join("b.zip");
        let real = create_backup_checked(&store, "0", &[], &dest).unwrap();
        assert!(stage(&store, &real).is_ok());
    }

    #[test]
    fn checked_backup_refuses_relative_and_dot_dot() {
        let (tmp, store) = seeded();
        assert!(check_backup_dest(&store, &[], Path::new("b.zip")).is_err());
        // A relative path whose folder exists (tests run in the crate dir) is refused too.
        assert!(check_backup_dest(&store, &[], Path::new("src/b.zip")).is_err());
        let out = outside();
        std::fs::create_dir_all(out.path().join("x")).unwrap();
        // x/../b.zip would resolve fine; `..` itself must be refused.
        let sneaky = out.path().join("x").join("..").join("b.zip");
        assert!(check_backup_dest(&store, &[], &sneaky).is_err());
        let into_data = out
            .path()
            .join("x")
            .join("..")
            .join("..")
            .join(tmp.path().strip_prefix("/").unwrap_or(tmp.path()))
            .join("coauthor.db.zip");
        assert!(check_backup_dest(&store, &[], &into_data).is_err());
    }

    #[test]
    fn checked_backup_refuses_all_data_dirs_including_backups_folder() {
        let (tmp, store) = seeded();
        assert!(check_backup_dest(&store, &[], &tmp.path().join("x.zip")).is_err());
        let other = outside();
        assert!(check_backup_dest(
            &store,
            &[other.path().to_path_buf()],
            &other.path().join("x.zip")
        )
        .is_err());
        // The backups folder is not a write target any more (#73): refused like the rest.
        std::fs::create_dir_all(tmp.path().join("backups")).unwrap();
        assert!(check_backup_dest(&store, &[], &tmp.path().join("backups").join("b.zip")).is_err());
        // Not a non-zip name, even outside.
        let out = outside();
        assert!(check_backup_dest(&store, &[], &out.path().join("evil.exe")).is_err());
        assert!(check_backup_dest(&store, &[], &out.path().join("nope").join("b.zip")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn checked_backup_refuses_symlink_escape_into_data_dir() {
        let (tmp, store) = seeded();
        let out = outside();
        let link = out.path().join("link");
        std::os::unix::fs::symlink(tmp.path(), &link).unwrap();
        let err = create_backup_checked(&store, "0", &[], &link.join("files.zip"));
        assert!(err.is_err());
        assert!(!tmp.path().join("files.zip").exists());
        // A dest that is itself a link to a file elsewhere is refused too.
        let victim = out.path().join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        let flink = out.path().join("b.zip");
        std::os::unix::fs::symlink(&victim, &flink).unwrap();
        assert!(create_backup_checked(&store, "0", &[], &flink).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    }

    #[test]
    fn failed_write_leaves_existing_dest_and_no_temp_file() {
        let (_tmp, store) = seeded();
        let out = outside();
        let dest = out.path().join("b.zip");
        std::fs::write(&dest, b"old backup").unwrap();
        assert!(create_backup_inner(&store, "0", &dest, true, true).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"old backup");
        let names: Vec<_> = std::fs::read_dir(out.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }
    #[test]
    fn unc_and_admin_share_paths_are_classified() {
        for p in [
            r"\\localhost\C$\Users\v\AppData\Roaming\x\b.zip",
            r"\\server\share\b.zip",
            r"\\?\UNC\localhost\C$\b.zip",
            r"\\?\unc\server\share\b.zip",
            r"\\.\pipe\x",
            "//server/share/b.zip",
        ] {
            assert!(is_unc_like(p), "{p}");
        }
        for p in [
            r"C:\Users\v\b.zip",
            r"\\?\C:\Users\v\b.zip",
            "/home/v/b.zip",
        ] {
            assert!(!is_unc_like(p), "{p}");
        }
    }

    #[test]
    fn check_backup_dest_refuses_unc_strings() {
        let (_tmp, store) = seeded();
        // Absolute only on Windows; on unix `//x/y` is absolute and must still be refused.
        assert!(check_backup_dest(&store, &[], Path::new("//server/share/b.zip")).is_err());
    }

    /// #73: the window must not be able to trigger a backup write without the save dialog.
    /// `create_backup` takes no arguments from the webview beyond the injected app/store,
    /// and the only write it reaches is `create_backup_checked` on the dialog's path.
    #[test]
    fn create_backup_command_has_no_unattended_path() {
        let src = include_str!("lib.rs");
        let start = src.find("async fn create_backup(").expect("command exists");
        let body = &src[start..];
        let sig_end = body.find(") -> Result<bool, String>").unwrap();
        let sig = &body[..sig_end];
        let params: Vec<&str> = sig
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(params.len(), 2, "unexpected webview args: {params:?}");
        assert!(params[0].starts_with("app: tauri::AppHandle"));
        assert!(params[1].starts_with("store: tauri::State"));
        let end = body.find("\nfn ").unwrap_or(body.len());
        let body = &body[..end];
        assert!(body.contains("blocking_save_file()"));
        assert!(!body.contains("default_backup_path"));
        assert!(!body.contains("create_backup_to("));
        assert_eq!(body.matches("backup::create_backup").count(), 1);
        assert!(body.contains("backup::create_backup_checked("));
    }

    /// Pre-rename fixture (#83): a backup written by the coAuthor-era format (manifest format
    /// `coauthor-backup`, file named `coauthor-backup-*.zip`). Regenerate only with
    /// `cargo test write_coauthor_era_fixture -- --ignored`; it must stay as committed.
    const COAUTHOR_ERA_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/backups/coauthor-backup-1761500000.zip"
    );

    #[test]
    #[ignore]
    fn write_coauthor_era_fixture() {
        let (_tmp, store) = seeded();
        store
            .with_sql(|c| c.execute_batch("UPDATE t SET body = 'Sample chapter — naïve café 😀.'"))
            .unwrap();
        create_backup(&store, "0.1.0", Path::new(COAUTHOR_ERA_FIXTURE)).unwrap();
    }

    #[test]
    fn coauthor_era_backup_restores_intact() {
        let fixture = Path::new(COAUTHOR_ERA_FIXTURE);
        // It really is a coAuthor-era backup.
        let mut za = zip::ZipArchive::new(File::open(fixture).unwrap()).unwrap();
        let mut buf = String::new();
        za.by_name(MANIFEST_ENTRY)
            .unwrap()
            .read_to_string(&mut buf)
            .unwrap();
        let m: Manifest = serde_json::from_str(&buf).unwrap();
        assert_eq!(m.format, "coauthor-backup");

        let (tmp, store) = seeded();
        store
            .with_sql(|c| c.execute_batch("UPDATE app_meta SET value='v2'; DELETE FROM t;"))
            .unwrap();
        std::fs::remove_dir_all(tmp.path().join("files")).unwrap();
        // Restore from a copy so a failing restore can never touch the committed fixture.
        let copy = tmp.path().join("picked.zip");
        std::fs::copy(fixture, &copy).unwrap();
        let out = restore_picked(&store, "0.2.0", &copy).unwrap();
        assert_eq!(out, RestoreOutcome { tokens_revoked: 0 });
        assert_eq!(meta(&store), "v1");
        let (body, blob): (String, Vec<u8>) = store
            .with_sql(|c| {
                c.query_row("SELECT body, blob FROM t", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
            })
            .unwrap();
        assert_eq!(body, "Sample chapter — naïve café 😀.");
        assert_eq!(blob, vec![1, 2, 255]);
        assert_eq!(
            std::fs::read(tmp.path().join("files/images/cover.png")).unwrap(),
            b"\x89PNGfake"
        );
    }

    /// #83: validation is by manifest format id and contents, not the file name.
    #[test]
    fn restore_validates_contents_not_file_name() {
        let (tmp, store) = seeded();
        // A real backup under an unrelated name and extension restores.
        let odd = tmp.path().join("notes.txt");
        create_backup(&store, "0.1.0", &odd).unwrap();
        store
            .with_sql(|c| c.execute_batch("UPDATE app_meta SET value='v2'"))
            .unwrap();
        restore_picked(&store, "0", &odd).unwrap();
        assert_eq!(meta(&store), "v1");

        // A backup-looking name with the wrong format id is refused, state untouched.
        store
            .with_sql(|c| c.execute_batch("UPDATE app_meta SET value='v3'"))
            .unwrap();
        let fake = tmp.path().join("swarmdraft-backup-1.zip");
        {
            let mut src = zip::ZipArchive::new(File::open(&odd).unwrap()).unwrap();
            let mut w = zip::ZipWriter::new(File::create(&fake).unwrap());
            for i in 0..src.len() {
                let mut e = src.by_index(i).unwrap();
                let name = e.name().to_string();
                let mut bytes = Vec::new();
                e.read_to_end(&mut bytes).unwrap();
                if name == MANIFEST_ENTRY {
                    let mut m: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    m["format"] = "other-backup".into();
                    bytes = serde_json::to_vec(&m).unwrap();
                }
                w.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                std::io::Write::write_all(&mut w, &bytes).unwrap();
            }
            w.finish().unwrap();
        }
        assert_eq!(restore_picked(&store, "0", &fake), Err(NOT_A_BACKUP));
        assert_eq!(meta(&store), "v3");
    }

    /// #83: the restore command takes no path from the webview (Tauri ignores unknown args,
    /// so this reads the source): only app/store, the native open dialog, and the label.
    #[test]
    fn restore_backup_command_takes_no_path() {
        let src = include_str!("lib.rs");
        let start = src
            .find("async fn restore_backup(")
            .expect("command exists");
        let body = &src[start..];
        let sig_end = body
            .find(") -> Result<Option<backup::RestoreOutcome>, String>")
            .unwrap();
        let params: Vec<&str> = body[..sig_end]
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(params.len(), 2, "unexpected webview args: {params:?}");
        assert!(params[0].starts_with("app: tauri::AppHandle"));
        assert!(params[1].starts_with("store: tauri::State"));
        let end = body.find("\nfn ").unwrap_or(body.len());
        let body = &body[..end];
        assert!(body.contains("blocking_pick_file()"));
        assert!(body.contains("backup::RESTORE_FILTER_NAME"));
        assert_eq!(body.matches("backup::restore_").count(), 1);
        assert!(body.contains("backup::restore_picked(&store, &version, &src)"));
        assert_eq!(RESTORE_FILTER_NAME, "swarmDraft backup");
    }
}
