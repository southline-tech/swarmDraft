//! First-run data migration for the swarmDraft rename (#43).
//!
//! The app identifier changed from `com.radiancelux.coauthor` to `com.radiancelux.swarmdraft`,
//! so Tauri now resolves `%APPDATA%` and `%LOCALAPPDATA%` to new folders. On the first start
//! after the update, each old folder is **copied** (never moved) to its new location:
//!
//! - Nothing happens when the new folder already exists (idempotent; later starts are no-ops).
//! - Nothing happens when there is no old folder (fresh install).
//! - The copy goes into a hidden temp folder next to the target and is renamed into place only
//!   once it is complete, so an interrupted copy never leaves a half-filled data folder. Stale
//!   temp folders from an interrupted run are removed and the copy starts over.
//! - The old folder is only ever read. It stays as a backup, and neither the app nor the
//!   uninstaller removes it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Identifier the app used before the rename.
pub const OLD_IDENTIFIER: &str = "com.radiancelux.coauthor";

const TEMP_PREFIX: &str = ".swarmdraft-migrating-";

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
    if new.exists() {
        return Ok(Outcome::AlreadyPresent);
    }
    if !old.is_dir() {
        return Ok(Outcome::NothingToMigrate);
    }
    let tmp = parent.join(format!(
        "{TEMP_PREFIX}{}-{}",
        new.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    if let Err(e) = copy_tree(old, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
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
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && entry.file_type()?.is_dir()
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

/// Recursive copy. Symlinks are skipped so nothing outside the data folder gets pulled in.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &dest)?;
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
        fs::write(old.join("coauthor.db"), b"db").unwrap();
        fs::write(old.join("files/sub/a.png"), [0u8, 1, 2, 255]).unwrap();
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
        assert_eq!(snapshot(&new), before, "copy differs");
    }

    #[test]
    fn idempotent_and_never_overwrites_new_data() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join(OLD_IDENTIFIER);
        let new = t.path().join("com.radiancelux.swarmdraft");
        seed(&old);
        migrate(&old, &new).unwrap();
        fs::write(new.join("coauthor.db"), b"newer").unwrap();
        fs::write(old.join("coauthor.db"), b"older").unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::AlreadyPresent);
        assert_eq!(fs::read(new.join("coauthor.db")).unwrap(), b"newer");
        assert_eq!(fs::read(old.join("coauthor.db")).unwrap(), b"older");
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
        assert!(!new.exists(), "a partial copy must never be visible as the data folder");
        assert_eq!(migrate(&old, &new).unwrap(), Outcome::Copied);
        assert!(!stale.exists());
        assert_eq!(snapshot(&new), snapshot(&old));
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
