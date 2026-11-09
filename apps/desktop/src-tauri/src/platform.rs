//! Platform paths and Finder `.draft` open (#193).
//!
//! Windows cold-start still passes the file on argv (`draft_path_from_argv` in `lib.rs`).
//! macOS Launch Services delivers the file as `RunEvent::Opened` (a `file://` URL), which
//! this module queues until the window asks for it, then emits `open-draft-path`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

/// How long a path just handed to the window is treated as the same open.
const OPEN_DEDUPE: Duration = Duration::from_secs(2);

/// Cold-start and Finder opens, consumed once by `draft_take_launch_path`.
#[derive(Default)]
pub struct LaunchDraftPath {
    pending: Mutex<Vec<String>>,
    taken: AtomicBool,
    recent: Mutex<Vec<(String, Instant)>>,
}

pub(crate) enum OpenedDraft {
    Queued,
    Emit(String),
    Duplicate,
}

impl LaunchDraftPath {
    /// Queue `path` until the frontend takes it, or ask the caller to emit if the window is up.
    pub(crate) fn offer(&self, path: String) -> OpenedDraft {
        let mut pending = self.pending.lock().expect("launch draft poisoned");
        if pending.iter().any(|p| p == &path) || self.is_recent(&path) {
            return OpenedDraft::Duplicate;
        }
        if self.taken.load(Ordering::SeqCst) {
            drop(pending);
            self.note(&path);
            return OpenedDraft::Emit(path);
        }
        pending.push(path);
        OpenedDraft::Queued
    }

    /// Mark the window as ready and return every path queued so far, in order.
    pub fn take_all(&self) -> Vec<String> {
        let mut pending = self.pending.lock().expect("launch draft poisoned");
        self.taken.store(true, Ordering::SeqCst);
        let paths = std::mem::take(&mut *pending);
        drop(pending);
        for path in &paths {
            self.note(path);
        }
        paths
    }

    fn is_recent(&self, path: &str) -> bool {
        let recent = self.recent.lock().expect("launch draft poisoned");
        recent
            .iter()
            .any(|(prev, at)| prev == path && at.elapsed() < OPEN_DEDUPE)
    }

    fn note(&self, path: &str) {
        let mut recent = self.recent.lock().expect("launch draft poisoned");
        recent.retain(|(_, at)| at.elapsed() < OPEN_DEDUPE);
        recent.push((path.to_string(), Instant::now()));
    }
}

/// `file://` URL from Finder / Launch Services → a `.draft` path, or `None`.
pub fn draft_path_from_open_url(raw: &str) -> Option<String> {
    let rest = raw.split(['?', '#']).next()?.strip_prefix("file://")?;
    let path = if let Some(after) = rest.strip_prefix("localhost") {
        after
    } else if rest.starts_with('/') {
        rest
    } else {
        return None;
    };
    let decoded = percent_decode(path);
    if decoded.is_empty() {
        return None;
    }
    let ext = Path::new(&decoded).extension()?.to_str()?;
    if ext.eq_ignore_ascii_case("draft") {
        Some(decoded)
    } else {
        None
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Exports folder under the Tauri app data directory.
///
/// The parent is `app.path().app_data_dir()`: `%APPDATA%\com.radiancelux.swarmdraft` on
/// Windows and `~/Library/Application Support/com.radiancelux.swarmdraft` on macOS.
pub fn exports_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("exports")
}

/// Plain description of where app data lives. Not shown in the editor.
pub fn app_data_location_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "~/Library/Application Support/com.radiancelux.swarmdraft"
    } else if cfg!(windows) {
        r"%APPDATA%\com.radiancelux.swarmdraft"
    } else {
        "$XDG_DATA_HOME/com.radiancelux.swarmdraft or ~/.local/share/com.radiancelux.swarmdraft"
    }
}

/// Deliver a `.draft` path from argv (second instance) or from a Finder open URL.
pub fn deliver_opened_draft(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<LaunchDraftPath>() {
        if let OpenedDraft::Emit(path) = state.offer(path) {
            let _ = app.emit("open-draft-path", path);
        }
        return;
    }
    let _ = app.emit("open-draft-path", path);
}

pub fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        for url in urls {
            if let Some(path) = draft_path_from_open_url(url.as_str()) {
                deliver_opened_draft(app, path);
            }
        }
        return;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finder_file_url_becomes_a_draft_path() {
        assert_eq!(
            draft_path_from_open_url("file:///Users/a/My%20Book.draft").as_deref(),
            Some("/Users/a/My Book.draft")
        );
        assert_eq!(
            draft_path_from_open_url("file://localhost/Users/a/Book.DRAFT").as_deref(),
            Some("/Users/a/Book.DRAFT")
        );
        assert_eq!(draft_path_from_open_url("file:///Users/a/notes.txt"), None);
        assert_eq!(
            draft_path_from_open_url("https://example.com/a.draft"),
            None
        );
    }

    #[test]
    fn launch_path_queues_until_taken_then_emits() {
        let slot = LaunchDraftPath::default();
        assert!(matches!(
            slot.offer("/tmp/a.draft".into()),
            OpenedDraft::Queued
        ));
        assert!(matches!(
            slot.offer("/tmp/a.draft".into()),
            OpenedDraft::Duplicate
        ));
        assert_eq!(slot.take_all(), vec!["/tmp/a.draft".to_string()]);
        assert!(slot.take_all().is_empty());
        assert!(matches!(
            slot.offer("/tmp/b.draft".into()),
            OpenedDraft::Emit(p) if p == "/tmp/b.draft"
        ));
        assert!(matches!(
            slot.offer("/tmp/a.draft".into()),
            OpenedDraft::Duplicate
        ));
    }

    #[test]
    fn exports_dir_is_under_app_data() {
        let data = Path::new("/Users/a/Library/Application Support/com.radiancelux.swarmdraft");
        assert_eq!(exports_dir(data), data.join("exports"));
        let hint = app_data_location_hint();
        if cfg!(target_os = "macos") {
            assert!(hint.contains("Library/Application Support"));
            assert!(!hint.contains("APPDATA"));
        } else if cfg!(windows) {
            assert!(hint.contains("APPDATA"));
        } else {
            assert!(hint.contains(".local/share"));
        }
    }
}
