//! coAuthor desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod backup;
pub mod mcp;
pub mod storage;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    schema_version: i64,
}

#[tauri::command]
fn app_info(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: store.data_dir().display().to_string(),
        schema_version: store.schema_version().map_err(|e| e.to_string())?,
    })
}

/// Write a full backup to `<data dir>/backups/` and return its path.
#[tauri::command]
fn create_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
) -> Result<String, String> {
    let dest = backup::default_backup_path(&store);
    backup::create_backup(&store, &app.package_info().version.to_string(), &dest)
        .map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
}

/// Validate and restore a backup .zip; the replaced state is kept as a pre-restore snapshot.
#[tauri::command]
fn restore_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    path: String,
) -> Result<backup::RestoreReport, String> {
    backup::restore_backup(
        &store,
        &app.package_info().version.to_string(),
        std::path::Path::new(&path),
    )
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = storage::Store::open(&dir)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            create_backup,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running coAuthor");
}
