//! First-run data migration for the swarmDraft rename (#43).
//!
//! The app identifier changed from `com.radiancelux.coauthor` to `com.radiancelux.swarmdraft`,
//! so Tauri now resolves `%APPDATA%` and `%LOCALAPPDATA%` to new folders. On the first start
//! after the update, each old folder is **copied** (never moved) to its new location:
//!
//! - A completed copy carries a marker file, written last. A new folder with the marker is
//!   never touched again (idempotent; later starts are no-ops).
//! - A new folder *without* the marker that holds no documents (an earlier copy failed and the
//!   app then created an empty folder) does not count as migrated: the copy is retried and the
//!   empty folder is kept aside under a `.before-migration-*` name, never deleted. A new folder
//!   without the marker that already holds documents is kept as is.
//! - The database is copied as a consistent SQLite snapshot: the db and `-wal` are copied byte
//!   for byte into staging, that copy is opened and checked, and `VACUUM INTO` writes the new
//!   db. SQLite never opens anything in the old folder. If the old database keeps changing or is
//!   locked, the copy fails with a message to close coAuthor and is retried on the next launch.
//! - Nothing happens when there is no old folder (fresh install), or when the old folder holds
//!   no database: a folder without a user database (`coauthor.db` or `swarmdraft.db`) has no user
//!   data (for example the old
//!   `%LOCALAPPDATA%` folder, which only holds the WebView2 `EBWebView` cache), so it is never
//!   copied. Caches the runtime recreates are not migrated.
//! - Only the roaming data folder is migrated ([`startup_migration`]); the local folder is
//!   left to WebView2.
//! - Migration reports to the user through its own [`MigrationNotice`] channel, never through
//!   restore recovery.
//! - The copy goes into a hidden temp folder next to the target and is renamed into place only
//!   once it is complete, so an interrupted copy never leaves a half-filled data folder. Stale
//!   temp folders from an interrupted run are removed and the copy starts over.
//! - The old folder is only ever read. It stays as a backup, and neither the app nor the
//!   uninstaller removes it.

use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Identifier the app used before the rename.
pub const OLD_IDENTIFIER: &str = "com.radiancelux.coauthor";

const TEMP_PREFIX: &str = ".swarmdraft-migrating-";

/// Written into the copy last; its presence means the copy is complete.
pub const MARKER: &str = ".swarmdraft-migrated";

/// Database file name in the new data folder (#198).
pub const DB_FILE: &str = "swarmdraft.db";

/// Database file name before the #198 rename; still used under the old identifier folder.
pub const LEGACY_DB_FILE: &str = "coauthor.db";

/// SQLite side files that are never copied raw; the snapshot replaces them.
const DB_SIDE_FILES: [&str; 3] = [
    "swarmdraft.db-wal",
    "swarmdraft.db-shm",
    "swarmdraft.db-journal",
];

const LEGACY_DB_SIDE_FILES: [&str; 3] =
    ["coauthor.db-wal", "coauthor.db-shm", "coauthor.db-journal"];

/// User database in `dir`, if any (modern name first).
fn user_db_in(dir: &Path) -> Option<PathBuf> {
    let modern = dir.join(DB_FILE);
    if modern.is_file() {
        return Some(modern);
    }
    let legacy = dir.join(LEGACY_DB_FILE);
    if legacy.is_file() {
        return Some(legacy);
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The new folder already existed; nothing was touched.
    AlreadyPresent,
    /// No old folder to copy (fresh install).
    NothingToMigrate,
    /// The old folder was copied to the new location.
    Copied,
    /// The new folder already held documents and was kept; the old documents were not copied.
    KeptExisting,
}

/// The pre-rename folder that sits next to `new_dir` (same parent, old identifier).
pub fn old_dir_for(new_dir: &Path) -> Option<PathBuf> {
    let name = new_dir.file_name()?;
    if name == OLD_IDENTIFIER {
        return None;
    }
    Some(new_dir.with_file_name(OLD_IDENTIFIER))
}

/// Copy `old` to `new` if `new` does not exist yet. `old` is never modified.
pub fn migrate(old: &Path, new: &Path) -> io::Result<Outcome> {
    let parent = new
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "data folder has no parent"))?;
    remove_stale_temps(parent, new)?;
    if new.join(MARKER).exists() {
        return Ok(Outcome::AlreadyPresent);
    }
    if new.exists() && !old.is_dir() {
        return Ok(Outcome::AlreadyPresent);
    }
    if !old.is_dir() || user_db_in(old).is_none() {
        // No database means no user data (e.g. only a WebView2 cache): nothing to copy.
        return Ok(Outcome::NothingToMigrate);
    }
    if new.exists() && has_documents(new) {
        // Real work already lives here; never hide it behind a copy of the old data.
        write_marker(new)?;
        return Ok(if user_db_in(old).is_some() {
            Outcome::KeptExisting
        } else {
            Outcome::AlreadyPresent
        });
    }
    let tmp = parent.join(format!(
        "{TEMP_PREFIX}{}-{}",
        new.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    let copied = copy_tree(old, &tmp, true).and_then(|()| write_marker(&tmp));
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if new.exists() {
        // An empty folder left by an earlier failed run: keep it aside, never delete it.
        let aside = aside_name(new);
        if let Err(e) = fs::rename(new, &aside) {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e);
        }
    }
    match fs::rename(&tmp, new) {
        Ok(()) => Ok(Outcome::Copied),
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            if new.exists() {
                // Another instance finished first; its copy is complete.
                Ok(Outcome::AlreadyPresent)
            } else {
                Err(e)
            }
        }
    }
}

/// A `.before-migration-{secs}` name that is not taken yet (`-2`, `-3`, … within one second).
fn aside_name(new: &Path) -> PathBuf {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let base = format!(
        "{}.before-migration-{secs}",
        new.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut p = new.with_file_name(&base);
    let mut n = 2u32;
    while p.exists() {
        p = new.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    p
}

/// Temp folders this module created for `new` in an earlier, interrupted run.
fn remove_stale_temps(parent: &Path, new: &Path) -> io::Result<()> {
    let prefix = format!(
        "{TEMP_PREFIX}{}-",
        new.file_name().unwrap_or_default().to_string_lossy()
    );
    let entries = match fs::read_dir(parent) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) && entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

fn write_marker(dir: &Path) -> io::Result<()> {
    let f = fs::File::create(dir.join(MARKER))?;
    f.sync_all()
}

/// True when `dir` holds a database with at least one manuscript.
fn has_documents(dir: &Path) -> bool {
    let Some(db) = user_db_in(dir) else {
        return false;
    };
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return true; // unreadable: assume it matters and leave it alone
    };
    conn.query_row("SELECT EXISTS(SELECT 1 FROM manuscripts)", [], |r| {
        r.get::<_, bool>(0)
    })
    .unwrap_or_else(|e| !e.to_string().contains("no such table"))
}

/// Shown when the old database is locked because coAuthor is still running.
pub const LOCKED_MESSAGE: &str =
    "The old coAuthor app is still open. Close it, then reopen swarmDraft.";

/// Plain text for any other copy failure; the technical error goes to the log only.
pub const COPY_FAILED_MESSAGE: &str =
    "swarmDraft couldn't bring over your earlier documents this time. They are safe in the old coAuthor folder, and swarmDraft will try again next time it opens.";

/// Shown when the new folder already holds documents, so the old ones were not copied in.
pub const KEPT_MESSAGE: &str =
    "swarmDraft already has documents, so your earlier coAuthor documents weren't copied over. They're still safe in the old coAuthor folder.";

/// How serious a [`MigrationNotice`] is. Serialized as `"info"` or `"warn"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind {
    Info,
    Warn,
}

/// A plain-text notice about the rename migration (or the old app still running). It has its
/// own channel (`migration_notices` / `dismiss_migration_notices`), separate from restore
/// recovery, and lives in memory only: a failed copy is retried and re-reported each launch,
/// and a completed copy is marked, so later launches produce no notice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MigrationNotice {
    /// Stable per text, so Dismiss removes only what was shown.
    pub id: String,
    pub kind: NoticeKind,
    /// Plain, user-facing text; technical details go to the log only.
    pub text: String,
}

impl MigrationNotice {
    pub fn new(kind: NoticeKind, text: &str) -> Self {
        let id = match text {
            KEPT_MESSAGE => "migration-kept",
            LOCKED_MESSAGE => "migration-locked",
            COPY_FAILED_MESSAGE => "migration-copy-failed",
            _ => "migration-other",
        };
        Self {
            id: id.to_string(),
            kind,
            text: text.to_string(),
        }
    }
}

/// Run the rename migration for the roaming data folder `new_dir` and return the notices to
/// show. Only the data folder is migrated; `%LOCALAPPDATA%` only holds the WebView2 cache.
pub fn startup_migration(new_dir: &Path) -> Vec<MigrationNotice> {
    let Some(old_dir) = old_dir_for(new_dir) else {
        return Vec::new();
    };
    match migrate(&old_dir, new_dir) {
        Ok(Outcome::KeptExisting) => {
            eprintln!(
                "swarmDraft: kept existing documents in {}; {} not copied",
                new_dir.display(),
                old_dir.display()
            );
            vec![MigrationNotice::new(NoticeKind::Info, KEPT_MESSAGE)]
        }
        Ok(_) => Vec::new(),
        Err(e) => {
            // Raw error and paths go to the log; the notice stays plain.
            eprintln!("swarmDraft: could not copy {}: {e}", old_dir.display());
            let text = if e.kind() == io::ErrorKind::WouldBlock {
                LOCKED_MESSAGE
            } else {
                COPY_FAILED_MESSAGE
            };
            vec![MigrationNotice::new(NoticeKind::Warn, text)]
        }
    }
}

/// How many times a changing or locked source is re-copied before giving up.
const SNAPSHOT_ATTEMPTS: u32 = 3;

fn side_path(src: &Path, ext: &str) -> PathBuf {
    let mut p = src.as_os_str().to_owned();
    p.push(ext);
    PathBuf::from(p)
}

/// (name, len, mtime) of the db and its side files, to detect a write during the copy.
fn fingerprint(src: &Path) -> Vec<(String, u64, Option<std::time::SystemTime>)> {
    ["", "-wal", "-shm", "-journal"]
        .iter()
        .filter_map(|ext| {
            let m = fs::metadata(side_path(src, ext)).ok()?;
            Some((ext.to_string(), m.len(), m.modified().ok()))
        })
        .collect()
}

/// Consistent snapshot of the old database into `dest`.
///
/// The old folder is never opened with SQLite (even a read-only open can create `-shm` there).
/// Instead the db and its `-wal` are copied byte for byte into a staging folder next to `dest`,
/// that copy is opened (SQLite replays the WAL into it), checked, and `VACUUM INTO` writes
/// `dest`. `-shm` is not copied: it is only an index SQLite rebuilds from the `-wal`, and a
/// live one can disagree with the copied `-wal`. If the source changes during the copy, is
/// locked, has a hot rollback journal, or the copy fails to open or check, it is retried and
/// then reported as [`LOCKED_MESSAGE`].
pub fn snapshot_db(src: &Path, dest: &Path) -> io::Result<()> {
    let staging = dest.with_file_name(".snapshot-src");
    let mut last = String::new();
    for attempt in 0..SNAPSHOT_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(dest);
        let r = snapshot_once(src, dest, &staging);
        let _ = fs::remove_dir_all(&staging);
        match r {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    let _ = fs::remove_file(dest);
    eprintln!("swarmDraft: old coAuthor database could not be snapshotted: {last}");
    Err(io::Error::new(io::ErrorKind::WouldBlock, LOCKED_MESSAGE))
}

fn snapshot_once(src: &Path, dest: &Path, staging: &Path) -> Result<(), String> {
    if side_path(src, "-journal").exists() {
        return Err("a rollback journal is present (write in progress)".into());
    }
    let before = fingerprint(src);
    fs::create_dir_all(staging).map_err(|e| format!("staging: {e}"))?;
    let copy = staging.join(DB_FILE);
    fs::copy(src, &copy).map_err(|e| format!("copy db: {e}"))?;
    let wal = side_path(src, "-wal");
    if wal.exists() {
        fs::copy(&wal, side_path(&copy, "-wal")).map_err(|e| format!("copy wal: {e}"))?;
    }
    if fingerprint(src) != before || side_path(src, "-journal").exists() {
        return Err("the database changed during the copy".into());
    }
    let conn = Connection::open(&copy).map_err(|e| format!("open copy: {e}"))?;
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("check copy: {e}"))?;
    if ok != "ok" {
        return Err(format!("quick_check: {ok}"));
    }
    let dest_str = dest.to_str().ok_or("non-UTF-8 data path")?;
    conn.execute("VACUUM INTO ?1", [dest_str])
        .map_err(|e| format!("vacuum into: {e}"))?;
    Ok(())
}

/// Recursive copy. Symlinks are skipped so nothing outside the data folder gets pulled in.
/// At the top level the database is snapshotted instead of copied byte for byte.
fn copy_tree(from: &Path, to: &Path, top: bool) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let name = entry.file_name();
        let dest = to.join(&name);
        if top
            && (name == MARKER
                || DB_SIDE_FILES.iter().any(|f| name == *f)
                || LEGACY_DB_SIDE_FILES.iter().any(|f| name == *f))
        {
            continue;
        }
        if ty.is_dir() {
            copy_tree(&entry.path(), &dest, false)?;
        } else if ty.is_file() {
            if top && name == LEGACY_DB_FILE {
                snapshot_db(&entry.path(), &to.join(DB_FILE))?;
            } else if top && name == DB_FILE {
                snapshot_db(&entry.path(), &dest)?;
            } else {
                fs::copy(entry.path(), &dest)?;
            }
        }
    }
    if let Ok(f) = fs::File::open(to) {
        let _ = f.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        fn walk(base: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let mut v: Vec<_> = fs::read_dir(d).unwrap().map(|e| e.unwrap()).collect();
            v.sort_by_key(|e| e.file_name());
            for e in v {
                let p = e.path();
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                if p.is_dir() {
                    out.push((rel + "/", Vec::new()));
                    walk(base, &p, out);
                } else {
                    out.push((rel, fs::read(&p).unwrap()));
                }
            }
        }
        walk(dir, dir, &mut out);
        out
    }

    fn seed_db(dir: &Path, db_file: &str) {
        fs::create_dir_all(dir.join("files/sub")).unwrap();
        let c = Connection::open(dir.join(db_file)).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.execute_batch(
            "CREATE TABLE manuscripts (id TEXT); INSERT INTO manuscripts VALUES ('m1');",
        )
        .unwrap();
        drop(c);
        fs::write(dir.join("files/sub/a.png"), [0u8, 1, 2, 255]).unwrap();
    }

    fn seed_old(dir: &Path) {
        seed_db(dir, LEGACY_DB_FILE);
    }

    fn seed_new(dir: &Path) {
        seed_db(dir, DB_FILE);
    }

    fn rows(dir: &Path) -> Vec<String> {
        let db = user_db_in(dir).expect("database");
        let c = Connection::open(db).unwrap();
        let mut st = c.prepare("SELECT id FROM manuscripts ORDER BY id").unwrap();
        let v = st
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        v
    }

    /// Files other than the database (which is a snapshot, not a byte copy) and the marker.
    fn non_db(v: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
        v.into_iter()
            .filter(|(n, _)| {
                !n.starts_with(DB_FILE) && !n.starts_with(LEGACY_DB_FILE) && n != MARKER
            })
            .collect()
    }

    #[test]
    fn failed_copy_then_empty_store_is_retried_next_launch() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        // Launch 1: old db locked, copy fails; the app then opens an empty store in `new`.
        let locker = Connection::open(old.join(LEGACY_DB_FILE)).unwrap();
        locker
            .pragma_update(None, "journal_mode", "DELETE")
            .unwrap();
        locker
            .execute_batch("BEGIN EXCLUSIVE; INSERT INTO manuscripts VALUES ('pending');")
            .unwrap();
        let err = migrate(&old, &new).unwrap_err();
        assert_eq!(err.to_string(), LOCKED_MESSAGE);
        assert!(!new.exists());
        fs::create_dir_all(&new).unwrap();
        Connection::open(new.join(DB_FILE))
            .unwrap()
            .execute_batch("CREATE TABLE manuscripts (id TEXT);")
            .unwrap();
        locker.execute_batch("ROLLBACK;").unwrap();
        drop(locker);
        // Launch 2: the empty folder doesn't count as migrated.
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(rows(&new), vec!["m1".to_string()]);
        assert!(new.join(MARKER).exists());
        let aside: Vec<_> = fs::read_dir(t.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".before-migration-")
            })
            .collect();
        assert_eq!(aside.len(), 1, "empty folder is kept aside, not deleted");
        // Launch 3: no-op.
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::AlreadyPresent);
    }

    #[test]
    fn unmarked_folder_with_documents_is_kept() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        seed_new(&new);
        Connection::open(new.join(DB_FILE))
            .unwrap()
            .execute("INSERT INTO manuscripts VALUES ('mine')", [])
            .unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::KeptExisting);
        assert_eq!(rows(&new), vec!["m1".to_string(), "mine".to_string()]);
        // The notice is one-time: the kept folder is now marked.
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::AlreadyPresent);
    }

    /// Names, bytes and mtimes of every entry under `dir`.
    fn hash_dir(dir: &Path) -> Vec<(String, Vec<u8>, Option<std::time::SystemTime>)> {
        snapshot(dir)
            .into_iter()
            .map(|(n, b)| {
                let m = fs::metadata(dir.join(n.trim_end_matches('/')))
                    .unwrap()
                    .modified()
                    .ok();
                (n, b, m)
            })
            .collect()
    }

    /// Old folder with a committed row ('m2') that lives only in `-wal` and no `-shm`, as left
    /// by a coAuthor crash. Built by copying a live db + wal, so nothing is checkpointed.
    fn crashed_old(root: &Path) -> PathBuf {
        let live_dir = root.join("live");
        seed_old(&live_dir);
        let live = Connection::open(live_dir.join(LEGACY_DB_FILE)).unwrap();
        live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        live.execute("INSERT INTO manuscripts VALUES ('m2')", [])
            .unwrap();
        let old = root.join(OLD_IDENTIFIER);
        fs::create_dir_all(old.join("files/sub")).unwrap();
        fs::copy(live_dir.join(LEGACY_DB_FILE), old.join(LEGACY_DB_FILE)).unwrap();
        fs::copy(
            live_dir.join("coauthor.db-wal"),
            old.join("coauthor.db-wal"),
        )
        .unwrap();
        fs::write(old.join("files/sub/a.png"), [0u8, 1, 2, 255]).unwrap();
        drop(live);
        assert!(!old.join("coauthor.db-shm").exists());
        old
    }

    #[test]
    fn crash_leftovers_old_folder_is_byte_identical_after_migration() {
        let t = tempfile::tempdir().unwrap();
        let old = crashed_old(t.path());
        let new = t.path().join("com.radiancelux.swarmdraft");
        let before = hash_dir(&old);
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(hash_dir(&old), before, "old folder was touched");
        assert_eq!(rows(&new), vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn live_old_folder_is_byte_identical_after_migration() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        let live = Connection::open(old.join(LEGACY_DB_FILE)).unwrap();
        live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        live.execute("INSERT INTO manuscripts VALUES ('m2')", [])
            .unwrap();
        let before = hash_dir(&old);
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(hash_dir(&old), before, "old folder was touched");
        assert_eq!(rows(&new), vec!["m1".to_string(), "m2".to_string()]);
        drop(live);
    }

    #[test]
    fn live_wal_is_snapshotted_not_copied_raw() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        // coAuthor still running: a committed write sits only in the -wal file.
        let live = Connection::open(old.join(LEGACY_DB_FILE)).unwrap();
        live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        live.execute("INSERT INTO manuscripts VALUES ('m2')", [])
            .unwrap();
        assert!(old.join("coauthor.db-wal").exists());
        let dest = t.path().join("snap.db");
        snapshot_db(&old.join(LEGACY_DB_FILE), &dest).unwrap();
        // No side files: everything is in the single file.
        for ext in ["-wal", "-shm", "-journal"] {
            assert!(!side_path(&dest, ext).exists(), "{ext} next to snapshot");
        }
        // The file alone holds the WAL row: open it immutable so no -wal could be consulted.
        let uri = format!("file:{}?immutable=1", dest.display());
        let c = Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM manuscripts WHERE id = 'm2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "WAL row missing from the single-file snapshot");
        // VACUUM output: rollback-journal header (bytes 18/19 == 1) and no free pages.
        let head = fs::read(&dest).unwrap();
        assert_eq!((head[18], head[19]), (1, 1), "not a VACUUM INTO file");
        let free: i64 = c
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert_eq!(free, 0);
        // And through migrate(): no side files land in the new folder either.
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(rows(&new), vec!["m1".to_string(), "m2".to_string()]);
        drop(live);
    }

    #[test]
    fn set_aside_names_never_collide() {
        let t = tempfile::tempdir().unwrap();
        let new = t.path().join("com.radiancelux.swarmdraft");
        let a = aside_name(&new);
        fs::create_dir_all(&a).unwrap();
        let b = aside_name(&new);
        assert_ne!(a, b);
        fs::create_dir_all(&b).unwrap();
        assert_ne!(aside_name(&new), b);
    }

    #[test]
    fn copies_and_leaves_original_untouched() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        let before = snapshot(&old);
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(snapshot(&old), before, "old folder changed");
        assert_eq!(non_db(snapshot(&new)), non_db(before), "copy differs");
        assert_eq!(rows(&new), vec!["m1".to_string()]);
    }

    #[test]
    fn idempotent_and_never_overwrites_new_data() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        migrate(&old, &new).unwrap();
        fs::write(new.join("files/n.txt"), b"newer").unwrap();
        fs::write(old.join("files/n.txt"), b"older").unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::AlreadyPresent);
        assert_eq!(fs::read(new.join("files/n.txt")).unwrap(), b"newer");
        assert_eq!(fs::read(old.join("files/n.txt")).unwrap(), b"older");
    }

    #[test]
    fn fresh_install_does_nothing() {
        let t = tempfile::tempdir().unwrap();
        let new = t.path().join("com.radiancelux.swarmdraft");
        let old = t.path().join(OLD_IDENTIFIER);
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::NothingToMigrate);
        assert!(!new.exists());
    }

    #[test]
    fn interrupted_copy_is_cleaned_up_and_redone() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        // A half-finished copy from a run that was killed mid-way.
        let stale = t
            .path()
            .join(format!("{TEMP_PREFIX}com.radiancelux.swarmdraft-999999"));
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join(DB_FILE), b"partial").unwrap();
        assert!(
            !new.exists(),
            "a partial copy must never be visible as the data folder"
        );
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert!(!stale.exists());
        assert_eq!(non_db(snapshot(&new)), non_db(snapshot(&old)));
        assert_eq!(rows(&new), vec!["m1".to_string()]);
    }

    #[test]
    fn old_dir_is_sibling_with_old_identifier() {
        let p = Path::new("/x/Roaming/com.radiancelux.swarmdraft");
        assert_eq!(
            old_dir_for(p).unwrap(),
            Path::new("/x/Roaming/com.radiancelux.coauthor")
        );
        assert_eq!(old_dir_for(Path::new("/x/com.radiancelux.coauthor")), None);
    }

    /// Old Local folder holding only the WebView2 cache, new Local folder already created by
    /// WebView2 without the marker: no copy, no error, no notice, on every run.
    #[test]
    fn local_webview_cache_only_is_never_migrated() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        fs::create_dir_all(old.join("EBWebView/Default/Cache")).unwrap();
        fs::write(old.join("EBWebView/Default/Cache/data_0"), b"old cache").unwrap();
        fs::create_dir_all(new.join("EBWebView/Default")).unwrap();
        fs::write(new.join("EBWebView/Default/lockfile"), b"in use").unwrap();
        for _ in 0..3 {
            assert_eq!(migrate(&old, &new).unwrap(), Outcome::NothingToMigrate);
            assert!(startup_migration(&new).is_empty());
            assert!(!new.join("EBWebView/Default/Cache").exists());
            assert_eq!(
                fs::read(new.join("EBWebView/Default/lockfile")).unwrap(),
                b"in use"
            );
            let names: Vec<_> = fs::read_dir(t.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names.len(), 2, "no aside or temp folders: {names:?}");
        }
    }

    /// After a full success, launches 2 and 3 produce no notices, and migration never trips
    /// restore recovery (no recovery notices, journal untouched).
    #[test]
    fn later_launches_after_success_are_silent_and_not_restore_recovery() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        assert!(startup_migration(&new).is_empty(), "launch 1");
        assert!(new.join(MARKER).exists());
        for launch in 2..=3 {
            assert!(startup_migration(&new).is_empty(), "launch {launch}");
            let report = crate::backup::cleanup_temp(&new);
            assert!(report.unsaved_notices.is_empty(), "launch {launch}");
            assert!(
                crate::backup::read_recovery_notices(&new).is_empty(),
                "launch {launch}"
            );
        }
    }

    /// A failed copy reports through the migration channel only, never as restore recovery.
    #[test]
    fn failed_copy_notice_is_a_migration_notice_not_recovery() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed_old(&old);
        fs::write(old.join(LEGACY_DB_FILE), b"not a sqlite database at all").unwrap();
        let notices = startup_migration(&new);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, NoticeKind::Warn);
        assert!(!new.exists() || crate::backup::read_recovery_notices(&new).is_empty());
        let json = serde_json::to_value(&notices[0]).unwrap();
        assert_eq!(json["kind"], "warn");
        assert!(json.get("reason").is_none() && json.get("retryPending").is_none());
    }
}
