//! "Save a copy" from the save-failure banner (#62, mockup ob9).
//!
//! The frontend builds a .docx of the manuscript as it is in memory (including edits the
//! database has not taken yet) and hands only the bytes here. The destination is picked in the
//! native save dialog opened from Rust, so no script in the webview can choose where a file is
//! written. The copy is written atomically: to a temp file in the same folder, synced, then
//! renamed into place, so a failure never leaves a half-written file or a damaged original.
//! Paths inside the app's data folders are refused so a copy can never replace app storage.

use std::fs::File;
use std::io::{Error, ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

/// True when `path` is `root` or inside it. On Windows paths compare case-insensitively.
fn is_within(path: &Path, root: &Path, case_insensitive: bool) -> bool {
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().into_owned();
                if case_insensitive {
                    s.to_lowercase()
                } else {
                    s
                }
            })
            .collect()
    };
    let (p, r) = (norm(path), norm(root));
    p.len() >= r.len() && p[..r.len()] == r[..]
}

/// True for UNC and admin-share forms (`\\\\server\\share`, `\\\\localhost\\C$`,
/// `\\\\?\\UNC\\...`, and the same with forward slashes). Their canonical form never
/// prefix-matches the drive-letter data folder, so they are refused outright.
pub(crate) fn is_unc_like(s: &str) -> bool {
    let s = s.replace('/', "\\");
    if s.get(..8)
        .is_some_and(|h| h.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        return true;
    }
    if s.starts_with("\\\\?\\") || s.starts_with("\\\\.\\") {
        // Verbatim/device drive paths (`\\?\C:\...`) are local; anything else is not.
        let rest = s.get(4..).unwrap_or("");
        let b = rest.as_bytes();
        return !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':');
    }
    s.starts_with("\\\\")
}

/// Check `dest` and return the real path the copy will be written to.
pub fn check_dest(data_dirs: &[PathBuf], dest: &Path) -> std::io::Result<PathBuf> {
    check_write_dest(data_dirs, dest, "docx", "copy")
}

/// Shared destination check for every user-picked write (save a copy #65, backup #73).
///
/// Refuses relative paths, UNC / admin-share paths, `.`/`..` components, a file name not
/// ending in `.{ext}`, a missing parent folder, a destination that is itself a symlink, and
/// anything that resolves (after canonicalizing the parent, so symlinks and junctions are
/// followed) into one of `data_dirs`. `what` names the file in error messages.
pub fn check_write_dest(
    data_dirs: &[PathBuf],
    dest: &Path,
    ext: &str,
    what: &str,
) -> std::io::Result<PathBuf> {
    let invalid = |m: String| Error::new(ErrorKind::InvalidInput, m);
    let denied = |m: String| Error::new(ErrorKind::PermissionDenied, m);
    if !dest.is_absolute() {
        return Err(invalid(format!("{what} path must be absolute")));
    }
    if is_unc_like(&dest.to_string_lossy()) {
        return Err(denied(format!(
            "permission denied: {what} path is a network share"
        )));
    }
    if dest
        .components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid(format!("{what} path must not contain . or ..")));
    }
    let name = dest
        .file_name()
        .ok_or_else(|| invalid(format!("{what} path has no file name")))?;
    let ext_ok = Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if !ext_ok {
        return Err(invalid(format!("{what} must be a .{ext} file")));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| invalid(format!("{what} path has no folder")))?;
    // Fails if the folder does not exist.
    let parent = parent.canonicalize()?;
    let real = parent.join(name);
    if std::fs::symlink_metadata(&real).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(denied(format!("permission denied: {what} path is a link")));
    }
    if is_unc_like(&real.to_string_lossy()) {
        return Err(denied(format!(
            "permission denied: {what} path is a network share"
        )));
    }
    let ci = cfg!(windows);
    // The pre-rename (com.radiancelux.coauthor) folders count as data folders too.
    let legacy = data_dirs
        .iter()
        .filter_map(|d| crate::migrate::old_dir_for(d));
    for dir in data_dirs.iter().cloned().chain(legacy) {
        let dir = dir.canonicalize().unwrap_or(dir);
        if is_within(&real, &dir, ci) {
            return Err(denied(format!(
                "permission denied: {what} path is inside the app data folder"
            )));
        }
    }
    Ok(real)
}

/// Write `bytes` to `dest` atomically after [`check_dest`]. Needs the shared
/// [`crate::backup::OpLock`] guard, so a copy never runs alongside a backup or restore (#100).
pub fn write_copy(
    _held: &crate::backup::OpGuard<'_>,
    data_dirs: &[PathBuf],
    dest: &Path,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    write_copy_with(data_dirs, dest, bytes, |f, b| f.write_all(b))
}

/// [`write_copy`] with the byte writer injectable, so tests can fail a write halfway.
fn write_copy_with(
    data_dirs: &[PathBuf],
    dest: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let real = check_dest(data_dirs, dest)?;
    let dir = real
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "copy path has no folder"))?;
    // Dropping the NamedTempFile on any error below deletes the temp file.
    let mut tmp = tempfile::Builder::new()
        .prefix(".save-copy-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    write(tmp.as_file_mut(), bytes)?;
    tmp.as_file().sync_all()?;
    // The save dialog already asked the user to confirm Replace for an existing file.
    tmp.persist(&real).map_err(|e| e.error)?;
    Ok(real)
}

/// A safe default file name for the save dialog from the manuscript title.
pub fn default_file_name(title: &str) -> String {
    let safe: String = title
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim().trim_matches('.').trim();
    let safe: String = safe.chars().take(120).collect();
    let safe = if safe.is_empty() { "Manuscript" } else { &safe };
    format!("{safe} (copy).docx")
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::backup::{OpGuard, OpLock, BUSY};
    use std::sync::mpsc;
    use std::time::Duration;

    fn held() -> OpGuard<'static> {
        Box::leak(Box::new(OpLock::default()))
            .try_acquire()
            .unwrap()
    }

    const WAIT: Duration = Duration::from_secs(10);

    /// The `save_manuscript_copy` command body, from lib.rs source.
    fn command_body() -> &'static str {
        let src = include_str!("lib.rs");
        let at = src
            .find("async fn save_manuscript_copy(")
            .expect("command exists");
        let body = &src[at..];
        &body[..body.find("\nfn ").unwrap_or(body.len())]
    }

    /// #100: writing a copy needs the shared op-lock guard; there is no unlocked entry point.
    #[test]
    fn write_copy_requires_the_op_lock_guard() {
        let src = include_str!("save_copy.rs");
        let src = &src[..src.find("#[cfg(test)]").unwrap()];
        let sig = &src[src.find("pub fn write_copy(").unwrap()..];
        let sig = &sig[..sig.find(')').unwrap()];
        assert!(
            sig.contains("_held: &crate::backup::OpGuard<'_>"),
            "write_copy must take the guard: {sig}"
        );
        assert_eq!(src.matches("pub fn write_copy").count(), 1);
        assert!(
            !src.contains("pub fn write_copy_with"),
            "unlocked writer stays private"
        );
        // The command passes the guard it took, not a fresh one.
        assert!(command_body().contains("save_copy::write_copy(&held,"));
    }

    /// #100: the lock is taken before the save dialog opens, and the dialog is parented.
    #[test]
    fn save_copy_command_locks_before_a_parented_dialog() {
        let body = command_body();
        let sig = &body[..body.find('{').unwrap()];
        assert!(sig.contains("window: tauri::Window"), "{sig}");
        let lock = body
            .find("app.state::<backup::OpLock>()")
            .expect("uses the shared lock");
        let acquire = body.find("try_acquire()").expect("takes the op lock");
        let dialog = body.find(".dialog()").expect("opens a dialog");
        assert!(lock < acquire && acquire < dialog, "lock before the dialog");
        assert!(body.contains(".set_parent(&window)"));
        assert!(
            body.find(".set_parent(&window)").unwrap() < body.find("blocking_save_file()").unwrap()
        );
        assert!(
            body.contains("map_err(str::to_string)?"),
            "busy is returned as-is"
        );
    }

    /// Runs `f` on a thread with a timeout so a deadlock fails instead of hanging CI.
    fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(WAIT).expect("thread finished in time")
    }

    /// #100: while a backup or restore holds the lock, Save a copy is busy.
    #[test]
    fn save_copy_is_busy_while_a_backup_or_restore_runs() {
        let lock: &'static OpLock = Box::leak(Box::new(OpLock::default()));
        let (held_tx, held_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let first = std::thread::spawn(move || {
            let _g = lock.try_acquire().unwrap(); // the backup / restore
            held_tx.send(()).unwrap();
            let _ = done_rx.recv_timeout(WAIT);
        });
        held_rx.recv_timeout(WAIT).expect("backup took the lock");
        let copy = on_thread(move || lock.try_acquire().err());
        assert_eq!(copy, Some(BUSY));
        done_tx.send(()).unwrap();
        first.join().unwrap();
        // Once it finishes, the copy goes ahead and writes.
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("b.docx");
        let g = lock.try_acquire().expect("released");
        write_copy(&g, &[], &dest, b"x").unwrap();
    }

    /// #100: while Save a copy holds the lock (dialog open or writing), backup and restore are busy.
    #[test]
    fn backup_and_restore_are_busy_while_save_copy_runs() {
        let lock: &'static OpLock = Box::leak(Box::new(OpLock::default()));
        let (held_tx, held_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("b.docx");
        let copy = std::thread::spawn(move || {
            let g = lock.try_acquire().unwrap();
            held_tx.send(()).unwrap();
            let _ = done_rx.recv_timeout(WAIT); // dialog open
            write_copy(&g, &[], &dest, b"x").map(|_| ())
        });
        held_rx.recv_timeout(WAIT).expect("copy took the lock");
        let others = on_thread(move || (lock.try_acquire().err(), lock.try_acquire().err()));
        assert_eq!(others, (Some(BUSY), Some(BUSY)));
        done_tx.send(()).unwrap();
        copy.join().unwrap().unwrap();
        assert!(lock.try_acquire().is_ok(), "released after the write");
    }

    fn dirs(d: &tempfile::TempDir) -> Vec<PathBuf> {
        vec![d.path().to_path_buf()]
    }

    #[test]
    fn refuses_a_destination_inside_the_old_app_id_folder() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("com.radiancelux.swarmdraft");
        let legacy = root.path().join(crate::migrate::OLD_IDENTIFIER);
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        let err = check_write_dest(&[data], &legacy.join("b.docx"), "docx", "copy").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn writes_the_bytes_and_leaves_no_temp_file() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        write_copy(&held(), &dirs(&data), &dest, b"hello").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
    }

    #[test]
    fn replaces_an_existing_file_the_user_confirmed() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        std::fs::write(&dest, b"old").unwrap();
        write_copy(&held(), &dirs(&data), &dest, b"new").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn a_write_failing_halfway_leaves_the_original_and_no_temp_file() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        std::fs::write(&dest, b"original").unwrap();
        let err = write_copy_with(&dirs(&data), &dest, b"new contents", |f, b| {
            f.write_all(&b[..b.len() / 2])?;
            Err(Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(err.to_string(), "disk full");
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        let names: Vec<_> = std::fs::read_dir(out.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("book.docx")]);
    }

    #[test]
    fn refuses_paths_inside_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let db = data.path().join("coauthor.docx");
        std::fs::write(&db, b"db").unwrap();
        let err = write_copy(&held(), &dirs(&data), &db, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&db).unwrap(), b"db");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_destination_that_is_itself_a_link() {
        let out = tempfile::tempdir().unwrap();
        let target = out.path().join("target.docx");
        std::fs::write(&target, b"keep").unwrap();
        let link = out.path().join("link.docx");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_copy(&held(), &[], &link, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }

    #[test]
    fn refuses_network_share_paths() {
        for p in ["//server/share/a.docx", "//localhost/C$/a.docx"] {
            let err = check_dest(&[], Path::new(p)).unwrap_err();
            assert!(
                matches!(
                    err.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::InvalidInput
                ),
                "{p}"
            );
        }
        assert!(is_unc_like(r"\\localhost\C$\a.docx"));
    }

    #[test]
    fn refuses_the_second_data_folder_too() {
        let roaming = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let both = vec![roaming.path().to_path_buf(), local.path().to_path_buf()];
        let err = check_dest(&both, &local.path().join("x.docx")).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn refuses_dot_dot_bypasses_into_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        // <out>/nope/../../<data name>/book.docx: "nope" does not exist.
        let rel = data
            .path()
            .strip_prefix(data.path().parent().unwrap())
            .unwrap();
        let bypass = out
            .path()
            .join("nope")
            .join("..")
            .join("..")
            .join(rel)
            .join("book.docx");
        assert_eq!(
            check_dest(&dirs(&data), &bypass).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        let dot = data.path().join(".").join("book.docx");
        assert!(check_dest(&dirs(&data), &dot).is_err());
        let up = out.path().join("..").join("book.docx");
        assert!(check_dest(&dirs(&data), &up).is_err());
        assert!(!data.path().join("book.docx").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_folder_that_points_into_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let link = out.path().join("link");
        std::os::unix::fs::symlink(data.path(), &link).unwrap();
        let err = check_dest(&dirs(&data), &link.join("book.docx")).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn data_folder_match_ignores_case_on_windows() {
        let root = Path::new("/Users/A/AppData/Local/App");
        let p = Path::new("/users/a/appdata/LOCAL/app/coauthor.docx");
        assert!(is_within(p, root, true));
        assert!(!is_within(p, root, false));
        assert!(!is_within(
            Path::new("/Users/A/AppData/Local/Apple/x.docx"),
            root,
            true
        ));
    }

    #[test]
    fn refuses_a_missing_folder_relative_paths_and_non_docx() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let missing = out.path().join("missing-folder").join("book.docx");
        assert!(write_copy(&held(), &dirs(&data), &missing, b"x").is_err());
        assert!(!missing.exists());
        assert!(write_copy(&held(), &dirs(&data), Path::new("book.docx"), b"x").is_err());
        for name in ["book.exe", "book.docx.bat", "book", "book.DOCX.lnk"] {
            let p = out.path().join(name);
            assert!(
                write_copy(&held(), &dirs(&data), &p, b"x").is_err(),
                "{name}"
            );
            assert!(!p.exists());
        }
        assert!(write_copy(&held(), &dirs(&data), &out.path().join("Book.DOCX"), b"x").is_ok());
    }

    #[test]
    fn default_file_name_is_safe() {
        assert_eq!(default_file_name("My Book"), "My Book (copy).docx");
        assert_eq!(default_file_name("../a\\b:c"), "a b c (copy).docx");
        assert_eq!(default_file_name("  "), "Manuscript (copy).docx");
    }
}
