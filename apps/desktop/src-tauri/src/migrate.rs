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
//! - The database is copied as a consistent SQLite snapshot (`VACUUM INTO`) read from the old
//!   database, never as raw `-wal`/`-shm` files, so a running coAuthor can't tear the copy. If
//!   the old database is locked, the copy fails with a message to close coAuthor and is retried
//!   on the next launch.
//! - Nothing happens when there is no old folder (fresh install).
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

/// Database file name (unchanged by the rename).
pub const DB_FILE: &str = "coauthor.db";

/// SQLite side files that are never copied raw; the snapshot replaces them.
const DB_SIDE_FILES: [&str; 3] = ["coauthor.db-wal", "coauthor.db-shm", "coauthor.db-journal"];

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The new folder already existed; nothing was touched.
    AlreadyPresent,
    /// No old folder to copy (fresh install).
    NothingToMigrate,
    /// The old folder was copied to the new location.
    Copied,
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
    if !old.is_dir() {
        return Ok(Outcome::NothingToMigrate);
    }
    if new.exists() && has_documents(new) {
        // Real work already lives here; never hide it behind a copy of the old data.
        write_marker(new)?;
        return Ok(Outcome::AlreadyPresent);
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
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let aside = new.with_file_name(format!(
            "{}.before-migration-{secs}",
            new.file_name().unwrap_or_default().to_string_lossy()
        ));
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
    let db = dir.join(DB_FILE);
    if !db.is_file() {
        return false;
    }
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

/// Consistent snapshot of the old database into `dest`, read-only on the source.
pub fn snapshot_db(src: &Path, dest: &Path) -> io::Result<()> {
    let busy = |e: rusqlite::Error| {
        let locked = matches!(
            e.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        );
        if locked {
            // Technical detail goes to the log; the user sees plain wording.
            eprintln!("swarmDraft: old coAuthor database is locked: {e}");
            io::Error::new(io::ErrorKind::WouldBlock, LOCKED_MESSAGE)
        } else {
            io::Error::other(format!("could not read the coAuthor database: {e}"))
        }
    };
    // coAuthor closed cleanly: no -wal/-shm, so the file alone is consistent. Copy its bytes
    // (opening it with SQLite, even read-only, would create side files in the old folder). If
    // side files appear meanwhile, coAuthor started, so fall through to the live snapshot.
    let side = |ext: &str| {
        let mut p = src.as_os_str().to_owned();
        p.push(ext);
        Path::new(&p).exists()
    };
    // Header bytes 18/19 == 2 mean WAL mode, which coAuthor always uses. In rollback-journal
    // mode a byte copy could catch a half-written page, so that mode always takes the snapshot.
    let wal_mode = {
        let mut h = [0u8; 20];
        fs::File::open(src)
            .and_then(|mut f| io::Read::read_exact(&mut f, &mut h))
            .is_ok()
            && h[18] == 2
            && h[19] == 2
    };
    if wal_mode && !side("-wal") && !side("-shm") {
        fs::copy(src, dest)?;
        if !side("-wal") && !side("-shm") {
            let ok = Connection::open(dest)
                .and_then(|c| c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))
                .map_err(busy)?;
            if ok == "ok" {
                return Ok(());
            }
            return Err(io::Error::other(format!(
                "the coAuthor database looks damaged ({ok})"
            )));
        }
        fs::remove_file(dest)?;
    }
    let conn = Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(busy)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(busy)?;
    let dest_str = dest
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF-8 data path"))?;
    conn.execute("VACUUM INTO ?1", [dest_str]).map_err(busy)?;
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
        if top && (name == MARKER || DB_SIDE_FILES.iter().any(|f| name == *f)) {
            continue;
        }
        if ty.is_dir() {
            copy_tree(&entry.path(), &dest, false)?;
        } else if ty.is_file() {
            if top && name == DB_FILE {
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

    fn seed(old: &Path) {
        fs::create_dir_all(old.join("files/sub")).unwrap();
        let c = Connection::open(old.join(DB_FILE)).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.execute_batch(
            "CREATE TABLE manuscripts (id TEXT); INSERT INTO manuscripts VALUES ('m1');",
        )
        .unwrap();
        drop(c);
        fs::write(old.join("files/sub/a.png"), [0u8, 1, 2, 255]).unwrap();
    }

    fn rows(dir: &Path) -> Vec<String> {
        let c = Connection::open(dir.join(DB_FILE)).unwrap();
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
            .filter(|(n, _)| !n.starts_with(DB_FILE) && n != MARKER)
            .collect()
    }

    #[test]
    fn failed_copy_then_empty_store_is_retried_next_launch() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed(&old);
        // Launch 1: old db locked, copy fails; the app then opens an empty store in `new`.
        let locker = Connection::open(old.join(DB_FILE)).unwrap();
        locker
            .pragma_update(None, "journal_mode", "DELETE")
            .unwrap();
        locker.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        let err = migrate(&old, &new).unwrap_err();
        assert_eq!(err.to_string(), LOCKED_MESSAGE);
        assert!(!new.exists());
        fs::create_dir_all(&new).unwrap();
        Connection::open(new.join(DB_FILE))
            .unwrap()
            .execute_batch("CREATE TABLE manuscripts (id TEXT);")
            .unwrap();
        locker.execute_batch("COMMIT;").unwrap();
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
    fn webview_folder_without_marker_is_retried() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        fs::create_dir_all(old.join("EBWebView/Default")).unwrap();
        fs::write(old.join("EBWebView/Default/state"), b"old").unwrap();
        fs::create_dir_all(new.join("EBWebView/Default")).unwrap();
        fs::write(new.join("EBWebView/Default/state"), b"fresh").unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(
            fs::read(new.join("EBWebView/Default/state")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn unmarked_folder_with_documents_is_kept() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed(&old);
        seed(&new);
        Connection::open(new.join(DB_FILE))
            .unwrap()
            .execute("INSERT INTO manuscripts VALUES ('mine')", [])
            .unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::AlreadyPresent);
        assert_eq!(rows(&new), vec!["m1".to_string(), "mine".to_string()]);
    }

    #[test]
    fn live_wal_is_snapshotted_not_copied_raw() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed(&old);
        // coAuthor still running: a committed write sits only in the -wal file.
        let live = Connection::open(old.join(DB_FILE)).unwrap();
        live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        live.execute("INSERT INTO manuscripts VALUES ('m2')", [])
            .unwrap();
        assert!(old.join("coauthor.db-wal").exists());
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert_eq!(rows(&new), vec!["m1".to_string(), "m2".to_string()]);
        assert!(!new.join("coauthor.db-wal").exists());
        assert!(!new.join("coauthor.db-shm").exists());
        drop(live);
    }

    #[test]
    fn copies_and_leaves_original_untouched() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed(&old);
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
        seed(&old);
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
        seed(&old);
        // A half-finished copy from a run that was killed mid-way.
        let stale = t
            .path()
            .join(format!("{TEMP_PREFIX}com.radiancelux.swarmdraft-999999"));
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("coauthor.db"), b"partial").unwrap();
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
}
