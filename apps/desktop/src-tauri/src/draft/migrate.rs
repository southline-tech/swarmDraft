//! One-time migration of legacy SQLite-only books into `.draft` files (#302).

use std::path::PathBuf;

use serde::Serialize;

use crate::storage::Store;

use super::service::DraftService;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMigrationNotice {
    pub manuscript_id: String,
    pub title: String,
    pub draft_path: String,
}

pub fn migrate_legacy_books_to_draft(
    store: &Store,
    drafts: &DraftService,
    drafts_dir: &PathBuf,
) -> Result<Vec<DraftMigrationNotice>, String> {
    std::fs::create_dir_all(drafts_dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for id in store.list_manuscript_ids().map_err(|e| e.to_string())? {
        if store
            .draft_file_path(&id)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            continue;
        }
        let m = store.get_manuscript(&id).map_err(|e| e.to_string())?;
        let file_name = format!("{}.draft", sanitize_filename(&m.title));
        let path = drafts_dir.join(file_name);
        store
            .set_draft_file_path(&id, &path.to_string_lossy())
            .map_err(|e| e.to_string())?;
        drafts
            .commit_now(
                store,
                &id,
                "Moved to swarmDraft file",
                "Author",
                "author@swarmdraft.local",
            )
            .map_err(|e| e.to_string())?;
        out.push(DraftMigrationNotice {
            manuscript_id: id,
            title: m.title,
            draft_path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}

fn sanitize_filename(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        "Untitled draft".into()
    } else {
        s
    }
}
