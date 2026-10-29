//! Progress events while a manuscript is imported or opened (issue #80, mockup ob6).

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "opening-progress";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub stage: String,
    /// Whole-number percent complete, 0–100.
    pub percent: u8,
    pub title: String,
    pub chapters_found: u32,
}

pub fn emit(app: &AppHandle, stage: &str, percent: u8, title: &str, chapters_found: u32) {
    let _ = app.emit(
        EVENT,
        Payload {
            stage: stage.to_string(),
            percent: percent.min(100),
            title: title.to_string(),
            chapters_found,
        },
    );
}

pub type Callback<'a> = dyn FnMut(&str, u8, &str, u32);

/// Map section index (0-based) to a percent in `start..=end`.
pub fn segment_percent(index: usize, total: usize, start: u8, end: u8) -> u8 {
    if total == 0 {
        return end;
    }
    let span = (end as u32).saturating_sub(start as u32);
    let done = ((index + 1) as u32 * span) / total as u32;
    (start as u32 + done).min(100) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_percent_empty_is_end() {
        assert_eq!(segment_percent(0, 0, 10, 90), 90);
    }

    #[test]
    fn segment_percent_reaches_end_on_last() {
        assert_eq!(segment_percent(9, 10, 0, 50), 50);
        assert_eq!(segment_percent(0, 10, 0, 50), 5);
    }
}
