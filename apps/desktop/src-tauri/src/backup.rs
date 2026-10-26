//! Backup and restore (RAD-224).
//!
//! A backup is a `.zip` with:
//! - `manifest.json`: format id/version, app + schema version, creation time, file list.
//! - `db/coauthor.db`: a consistent snapshot of the WAL-mode database taken with
//!   `VACUUM INTO` (includes every table: manuscripts, Yjs doc updates, comments, ...).
//! - `files/...`: everything under the data dir's `files/` folder (images, attachments).
//!
//! Restore validates the archive (manifest, safe entry names, SQLite integrity, schema
//! version not newer than this build), writes a `pre-restore-*.zip` snapshot of the current
//! state, then copies the backup into the live connection with the SQLite backup API.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::storage::{StorageError, Store};

pub const FORMAT: &str = "coauthor-backup";
pub const FORMAT_VERSION: u32 = 1;
const DB_ENTRY: &str = "db/coauthor.db";
const MANIFEST_ENTRY: &str = "manifest.json";
const FILES_PREFIX: &str = "files/";
/// Refuse absurd archives (zip bombs): 4 GiB uncompressed total.
const MAX_TOTAL_BYTES: u64 = 4 << 30;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at_unix: u64,
    pub files: Vec<String>,
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
}

fn invalid(msg: impl Into<String>) -> BackupError {
    BackupError::Invalid(msg.into())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Default location for a new backup: `<data dir>/backups/coauthor-backup-<unix>.zip`.
pub fn default_backup_path(store: &Store) -> PathBuf {
    store
        .data_dir()
        .join("backups")
        .join(format!("coauthor-backup-{}.zip", now_unix()))
}

fn files_dir(store: &Store) -> PathBuf {
    store.data_dir().join("files")
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

/// Write a full backup to `dest` and return its manifest.
pub fn create_backup(
    store: &Store,
    app_version: &str,
    dest: &Path,
) -> Result<Manifest, BackupError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = tempfile::Builder::new()
        .prefix(".backup-")
        .tempdir_in(store.data_dir())?;
    let snap = tmp.path().join("snapshot.db");
    store.with_conn(|c| {
        c.execute("VACUUM INTO ?1", [snap.to_string_lossy()])
            .map(|_| ())
    })?;

    let files = list_files(&files_dir(store))?;
    let manifest = Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        app_version: app_version.into(),
        schema_version: store.schema_version()?,
        created_at_unix: now_unix(),
        files: files.iter().map(|(r, _)| r.clone()).collect(),
    };

    // Write to a sibling temp file and rename, so a crash never leaves a half zip at `dest`.
    let part = dest.with_extension("zip.part");
    {
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
    }
    std::fs::rename(&part, dest)?;
    Ok(manifest)
}

/// Safe relative path for an archive entry (no absolute paths, `..`, drive prefixes).
fn safe_rel(name: &str) -> Result<PathBuf, BackupError> {
    let p = Path::new(name);
    if name.contains('\\') || name.contains(':') {
        return Err(invalid(format!("unsafe entry name {name:?}")));
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return Err(invalid(format!("unsafe entry name {name:?}"))),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(invalid("empty entry name"));
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

    let mut names = std::collections::HashSet::new();
    let mut total: u64 = 0;
    for i in 0..za.len() {
        let e = za.by_index_raw(i)?;
        if e.encrypted() {
            return Err(invalid("encrypted entries are not supported"));
        }
        if !names.insert(e.name().to_string()) {
            return Err(invalid(format!("duplicate entry {:?}", e.name())));
        }
        total = total.saturating_add(e.size());
    }
    if total > MAX_TOTAL_BYTES {
        return Err(invalid("archive too large"));
    }

    let manifest: Manifest = {
        let mut e = za
            .by_name(MANIFEST_ENTRY)
            .map_err(|_| invalid("missing manifest.json"))?;
        let mut buf = String::new();
        e.read_to_string(&mut buf)?;
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

    let dir = tempfile::Builder::new()
        .prefix(".restore-")
        .tempdir_in(store.data_dir())?;
    let db = dir.path().join("restore.db");
    let files = dir.path().join("files");
    std::fs::create_dir_all(&files)?;
    let mut saw_db = false;
    for i in 0..za.len() {
        let mut e = za.by_index(i)?;
        let name = e.name().to_string();
        if e.is_dir() || name == MANIFEST_ENTRY {
            continue;
        }
        let target = if name == DB_ENTRY {
            saw_db = true;
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
        let mut out = File::create(&target)?;
        // Bound the read by the declared size so a lying header can't bomb us.
        let n = std::io::copy(&mut (&mut e).take(MAX_TOTAL_BYTES), &mut out)?;
        if n != e.size() {
            return Err(invalid(format!("size mismatch in {name:?}")));
        }
    }
    if !saw_db {
        return Err(invalid("missing db/coauthor.db"));
    }

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
    pub manifest: Manifest,
    /// Snapshot of the state that was replaced; restore it to undo.
    pub pre_restore_snapshot: String,
}

/// Validate `src`, snapshot current state, then replace the database and files with the backup.
/// Nothing is modified unless validation and the pre-restore snapshot both succeed.
pub fn restore_backup(
    store: &Store,
    app_version: &str,
    src: &Path,
) -> Result<RestoreReport, BackupError> {
    let staged = stage(store, src)?;
    let snapshot = store
        .data_dir()
        .join("backups")
        .join(format!("pre-restore-{}.zip", now_unix()));
    create_backup(store, app_version, &snapshot)?;

    store.with_conn_mut(|c| {
        c.restore(
            rusqlite::DatabaseName::Main,
            &staged.db,
            None::<fn(rusqlite::backup::Progress)>,
        )
    })?;
    store.migrate_now()?;

    let live = files_dir(store);
    if live.exists() {
        std::fs::remove_dir_all(&live)?;
    }
    if staged.files.read_dir()?.next().is_some() {
        copy_tree(&staged.files, &live)?;
    }
    Ok(RestoreReport {
        manifest: staged.manifest,
        pre_restore_snapshot: snapshot.display().to_string(),
    })
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    for (rel, path) in list_files(from)? {
        let t = rel.split('/').fold(to.to_path_buf(), |p, s| p.join(s));
        if let Some(p) = t.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(path, t)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        store
            .with_conn(|c| {
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
            .with_conn(|c| {
                c.query_row("SELECT value FROM app_meta WHERE key='k'", [], |r| r.get(0))
            })
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
            .with_conn(|c| c.execute_batch("UPDATE app_meta SET value='v2'; DELETE FROM t;"))
            .unwrap();
        std::fs::remove_dir_all(tmp.path().join("files")).unwrap();
        std::fs::write(tmp.path().join("files-marker"), b"x").unwrap();

        let r = restore_backup(&store, "0.1.0", &zip).unwrap();
        assert_eq!(meta(&store), "v1");
        let (body, blob): (String, Vec<u8>) = store
            .with_conn(|c| {
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

    fn manifest_json(schema: i64) -> Vec<u8> {
        serde_json::to_vec(&Manifest {
            format: FORMAT.into(),
            format_version: 1,
            app_version: "0".into(),
            schema_version: schema,
            created_at_unix: 0,
            files: vec![],
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
        type Case<'a> = (&'a str, Vec<(&'a str, Vec<u8>)>);
        let cases: Vec<Case> = vec![
            (
                "traversal",
                vec![
                    (MANIFEST_ENTRY, manifest_json(v)),
                    (DB_ENTRY, db.clone()),
                    ("files/../../evil", b"x".to_vec()),
                ],
            ),
            (
                "windows path",
                vec![
                    (MANIFEST_ENTRY, manifest_json(v)),
                    (DB_ENTRY, db.clone()),
                    ("files/..\\evil", b"x".to_vec()),
                ],
            ),
            (
                "drive",
                vec![
                    (MANIFEST_ENTRY, manifest_json(v)),
                    (DB_ENTRY, db.clone()),
                    ("files/C:/evil", b"x".to_vec()),
                ],
            ),
            (
                "newer schema",
                vec![
                    (MANIFEST_ENTRY, manifest_json(v + 1)),
                    (DB_ENTRY, db.clone()),
                ],
            ),
            (
                "corrupt db",
                vec![
                    (MANIFEST_ENTRY, manifest_json(v)),
                    (DB_ENTRY, b"SQLite format 3\0garbage".to_vec()),
                ],
            ),
            ("no db", vec![(MANIFEST_ENTRY, manifest_json(v))]),
            ("no manifest", vec![(DB_ENTRY, db.clone())]),
        ];
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
}
