//! Native window title updates. Skips redundant Win32 title churn (#356 round 3).
//!
//! On Windows every `set_title` crosses into wry’s HWND subclass and posts `Wry::ExecMsg`.
//! That path ends in `RedrawWindow(..., RDW_INTERNALPAINT)` (`wry` `webview2/mod.rs`),
//! which can keep the Tao main thread awake when title/caption tweaks repeat.

use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
pub struct MainWindowTitle(pub Mutex<Option<String>>);

#[must_use]
pub fn title_unchanged(cached: &Option<String>, title: &str) -> bool {
    cached.as_deref() == Some(title)
}

pub fn set_if_changed<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
) -> Result<bool, String> {
    let state = window.state::<MainWindowTitle>();
    let mut guard = state.0.lock().expect("main window title poisoned");
    if title_unchanged(&guard, title) {
        return Ok(false);
    }
    window.set_title(title).map_err(|e| e.to_string())?;
    *guard = Some(title.to_string());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_unchanged_skips_native_set_title() {
        assert!(title_unchanged(&Some("My Book".into()), "My Book"));
        assert!(!title_unchanged(&Some("My Book".into()), "Other"));
        assert!(!title_unchanged(&None, "My Book"));
    }
}
