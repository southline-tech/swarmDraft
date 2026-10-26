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
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::storage::{StorageError, Store};

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

/// Default location for a new backup: `<data dir>/backups/coauthor-backup-<unique>.zip`.
pub fn default_backup_path(store: &Store) -> PathBuf {
    backups_dir(store).join(format!("coauthor-backup-{}.zip", unique_suffix()))
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

/// Restore id recorded in the live db, if any. Opened read-only and independent of [`Store`].
fn live_restore_id(data_dir: &Path) -> Option<String> {
    let db = data_dir.join("coauthor.db");
    if !db.exists() {
        return None;
    }
    let c = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).ok()?;
    c.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        [crate::storage::RESTORE_ID_KEY],
        |r| r.get(0),
    )
    .ok()
}

/// Finish or undo a restore interrupted by a crash, using the journal. If the live db carries
/// the journal's restore id, the db copy committed: keep the restored `files/` and drop the old
/// one. Otherwise the db is still the pre-restore db: drop the restored `files/` and put the
/// old one back. Returns whether a journal was found.
fn recover_journal(data_dir: &Path) -> bool {
    let path = data_dir.join(JOURNAL);
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let files = data_dir.join("files");
    let j: Option<Journal> = serde_json::from_slice(&bytes).ok();
    let committed = match &j {
        Some(j) => live_restore_id(data_dir).as_deref() == Some(j.id.as_str()),
        // Unreadable journal: it is fsynced before any change, so treat as not committed.
        None => false,
    };
    let old = j
        .as_ref()
        .and_then(|j| j.old.as_ref())
        .map(|n| data_dir.join(n));
    if committed {
        if let Some(old) = &old {
            let _ = std::fs::remove_dir_all(old);
        }
    } else {
        let old_exists = old.as_ref().is_some_and(|o| o.exists());
        // Only touch files/ when it is the restored copy: either the old dir is still set
        // aside, or there was no old dir at all (restore created files/ from nothing).
        let had_no_old = j.as_ref().is_some_and(|j| j.old.is_none());
        if old_exists || had_no_old {
            if files.exists() {
                let trash = data_dir.join(format!(".restore-trash-{}", unique_suffix()));
                if rename_retry(&files, &trash).is_ok() {
                    let _ = std::fs::remove_dir_all(&trash);
                }
            }
            if let Some(old) = &old {
                if old_exists {
                    let _ = rename_retry(old, &files);
                }
            }
        }
    }
    sync_dir(data_dir);
    let _ = remove_journal(data_dir);
    true
}

/// Recover from a crash mid-restore (see [`recover_journal`]) and remove temp dirs/files left
/// by a crash mid-backup or mid-restore. Call at startup, before opening the [`Store`].
/// Without a journal, a `.files-old-*` dir is only put back if `files/` is missing.
pub fn cleanup_temp(data_dir: &Path) {
    recover_journal(data_dir);
    let files = data_dir.join("files");
    let Ok(rd) = std::fs::read_dir(data_dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !TMP_PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        let path = e.path();
        if name.starts_with(".files-old-") && !files.exists() {
            let _ = std::fs::rename(&path, &files);
        } else if path.is_dir() {
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
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    res.map(|_| manifest)
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

    let tokens_revoked = match apply(store, &staged, fail, true) {
        Ok(n) => n,
        Err(err) if matches!(fail, FailAt::Crash(_)) => return Err(err),
        Err(err) => {
            drop(staged);
            // Rollback returns to the pre-restore state exactly, so tokens valid then stay valid.
            let rb = stage(store, &snapshot).and_then(|s| apply(store, &s, FailAt::None, false));
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
    if matches!(e.raw_os_error(), Some(32) | Some(33)) {
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
        let _ = remove_journal(dir);
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
        assert!(live_restore_id(tmp.path()).is_some());
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
}
