//! coAuthor desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `agents`: agent principals and hashed per-agent bearer tokens (RAD-205).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod agents;
pub mod anchor;
pub mod backup;
pub mod content;
pub mod manuscripts;
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

fn err(e: storage::StorageError) -> String {
    e.to_string()
}

#[tauri::command]
fn agents_list(store: tauri::State<'_, storage::Store>) -> Result<Vec<agents::Agent>, String> {
    store.list_agents().map_err(err)
}

#[tauri::command]
fn agent_create(
    store: tauri::State<'_, storage::Store>,
    name: String,
    color: String,
) -> Result<agents::Agent, String> {
    store.create_agent(&name, &color).map_err(err)
}

#[tauri::command]
fn agent_revoke(store: tauri::State<'_, storage::Store>, agent_id: String) -> Result<(), String> {
    store.revoke_agent(&agent_id).map_err(err)
}

#[tauri::command]
fn agent_tokens_list(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
) -> Result<Vec<agents::TokenInfo>, String> {
    store.list_tokens(&agent_id).map_err(err)
}

#[tauri::command]
fn agent_token_create(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
    scopes: Option<Vec<String>>,
) -> Result<agents::NewToken, String> {
    store
        .create_token(&agent_id, scopes.as_deref())
        .map_err(err)
}

#[tauri::command]
fn agent_token_revoke(
    store: tauri::State<'_, storage::Store>,
    token_id: String,
) -> Result<(), String> {
    store.revoke_token(&token_id).map_err(err)
}

/// Write a full backup to `dest` (from the save dialog; `replace` = user confirmed Replace,
/// which atomically replaces an existing file) or, if omitted,
/// to `<data dir>/backups/`, and return its path.
#[tauri::command]
fn create_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    dest: Option<String>,
    replace: Option<bool>,
) -> Result<String, String> {
    let replace = replace.unwrap_or(false) && dest.is_some();
    let dest = dest
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| backup::default_backup_path(&store));
    backup::create_backup_to(
        &store,
        &app.package_info().version.to_string(),
        &dest,
        replace,
    )
    .map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
}

/// Recovery notices that could not be saved to disk; shown from memory until dismissed.
#[derive(Default)]
struct UnsavedNotices(std::sync::Mutex<Vec<backup::RecoveryNotice>>);

/// Notices left by startup recovery when it moved folders aside. Reading does not clear them.
#[tauri::command]
fn recovery_notices(
    store: tauri::State<'_, storage::Store>,
    unsaved: tauri::State<'_, UnsavedNotices>,
) -> Vec<backup::RecoveryNotice> {
    let mut all = backup::read_recovery_notices(store.data_dir());
    all.extend(
        unsaved
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned(),
    );
    all
}

/// The user pressed Dismiss: clear the notices that were shown (by id); newer ones stay.
#[tauri::command]
fn dismiss_recovery_notices(
    store: tauri::State<'_, storage::Store>,
    unsaved: tauri::State<'_, UnsavedNotices>,
    ids: Vec<String>,
) -> Result<(), String> {
    unsaved
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|n| !ids.contains(&n.id));
    backup::dismiss_recovery_notices(store.data_dir(), &ids).map_err(|e| e.to_string())
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

/// One section of an imported manuscript: ProseMirror JSON from the .docx importer.
#[derive(serde::Deserialize)]
pub struct ImportSection {
    kind: String,
    title: String,
    doc: serde_json::Value,
}

#[tauri::command]
fn manuscript_import_json(
    store: tauri::State<'_, storage::Store>,
    title: String,
    sections: Vec<ImportSection>,
) -> Result<manuscripts::Manuscript, String> {
    let m = store.create_manuscript(&title).map_err(err)?;
    for s in sections {
        store
            .import_section_json(&m.id, &s.kind, &s.title, &s.doc)
            .map_err(err)?;
    }
    Ok(m)
}

#[tauri::command]
fn manuscripts_list(
    store: tauri::State<'_, storage::Store>,
) -> Result<Vec<manuscripts::Manuscript>, String> {
    store.list_manuscripts().map_err(err)
}

/// Where the MCP server is listening, or why it is not.
#[derive(Clone, serde::Serialize)]
pub struct McpStatus {
    url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn mcp_status(status: tauri::State<'_, std::sync::Mutex<McpStatus>>) -> McpStatus {
    status.lock().expect("status poisoned").clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let report = backup::cleanup_temp(&dir);
            app.manage(UnsavedNotices(std::sync::Mutex::new(
                report.unsaved_notices,
            )));
            let store = storage::Store::open(&dir)?;
            app.manage(store.clone());
            app.manage(std::sync::Mutex::new(McpStatus {
                url: None,
                error: None,
            }));
            // The MCP server shares the store. If the port is taken, the app still runs and
            // the settings screen shows the error.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = mcp::serve(store, mcp::DEFAULT_PORT).await;
                let state = handle.state::<std::sync::Mutex<McpStatus>>();
                let mut st = state.lock().expect("status poisoned");
                match result {
                    Ok(addr) => st.url = Some(format!("http://{addr}/mcp")),
                    Err(e) => {
                        eprintln!("MCP server not started: {e}");
                        st.error = Some(e.to_string());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            agents_list,
            agent_create,
            agent_revoke,
            agent_tokens_list,
            agent_token_create,
            agent_token_revoke,
            create_backup,
            recovery_notices,
            dismiss_recovery_notices,
            restore_backup,
            manuscript_import_json,
            manuscripts_list,
            mcp_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running coAuthor");
}
