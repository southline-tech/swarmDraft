//! Native macOS menu bar (#193).
//!
//! Edit is required so copy, paste, and the other standard commands reach the webview.
//! Windows and Linux keep the in-app book menu only; this module does not call `set_menu` there.

/// Application menu, then File, Edit, and Window. The first title is the fallback when
/// `productName` is empty; the installed app menu uses the configured product name.
pub const MACOS_MENU_TITLES: &[&str] = &["swarmDraft", "File", "Edit", "Window"];

pub const APP_MENU_ACTIONS: &[&str] = &[
    "about",
    "separator",
    "services",
    "separator",
    "hide",
    "hide_others",
    "separator",
    "quit",
];

pub const FILE_MENU_ACTIONS: &[&str] = &["close_window"];

/// Standard Edit menu. Copy and paste must stay here (#193).
pub const EDIT_MENU_ACTIONS: &[&str] = &[
    "undo",
    "redo",
    "separator",
    "cut",
    "copy",
    "paste",
    "select_all",
];

pub const WINDOW_MENU_ACTIONS: &[&str] = &["minimize", "maximize", "separator", "close_window"];

/// Install the macOS menu bar. No-op on Windows and Linux.
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        install_macos(app)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu};

    let title = app
        .config()
        .product_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| MACOS_MENU_TITLES[0].to_string());
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(title.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = submenu_from(app, &title, APP_MENU_ACTIONS, &about)?;
    let file_menu = submenu_from(app, MACOS_MENU_TITLES[1], FILE_MENU_ACTIONS, &about)?;
    let edit_menu = submenu_from(app, MACOS_MENU_TITLES[2], EDIT_MENU_ACTIONS, &about)?;
    let window_menu = submenu_from(app, MACOS_MENU_TITLES[3], WINDOW_MENU_ACTIONS, &about)?;
    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn submenu_from(
    app: &tauri::AppHandle,
    title: &str,
    actions: &[&str],
    about: &tauri::menu::AboutMetadata<'_>,
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::IsMenuItem;

    let mut owned = Vec::with_capacity(actions.len());
    for action in actions {
        owned.push(predefined(app, action, about)?);
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = owned
        .iter()
        .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    tauri::menu::Submenu::with_items(app, title, true, &refs)
}

#[cfg(target_os = "macos")]
fn predefined(
    app: &tauri::AppHandle,
    action: &str,
    about: &tauri::menu::AboutMetadata<'_>,
) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    use tauri::menu::PredefinedMenuItem;
    match action {
        "about" => PredefinedMenuItem::about(app, None, Some(about.clone())),
        "separator" => PredefinedMenuItem::separator(app),
        "services" => PredefinedMenuItem::services(app, None),
        "hide" => PredefinedMenuItem::hide(app, None),
        "hide_others" => PredefinedMenuItem::hide_others(app, None),
        "quit" => PredefinedMenuItem::quit(app, None),
        "close_window" => PredefinedMenuItem::close_window(app, None),
        "undo" => PredefinedMenuItem::undo(app, None),
        "redo" => PredefinedMenuItem::redo(app, None),
        "cut" => PredefinedMenuItem::cut(app, None),
        "copy" => PredefinedMenuItem::copy(app, None),
        "paste" => PredefinedMenuItem::paste(app, None),
        "select_all" => PredefinedMenuItem::select_all(app, None),
        "minimize" => PredefinedMenuItem::minimize(app, None),
        "maximize" => PredefinedMenuItem::maximize(app, None),
        other => unreachable!("unknown macOS menu action {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_menu_bar_is_app_file_edit_window() {
        assert_eq!(MACOS_MENU_TITLES, ["swarmDraft", "File", "Edit", "Window"]);
        assert!(FILE_MENU_ACTIONS.contains(&"close_window"));
        assert!(WINDOW_MENU_ACTIONS.contains(&"minimize"));
    }

    #[test]
    fn macos_edit_menu_includes_copy_and_paste() {
        assert!(EDIT_MENU_ACTIONS.contains(&"copy"));
        assert!(EDIT_MENU_ACTIONS.contains(&"paste"));
        assert!(EDIT_MENU_ACTIONS.contains(&"cut"));
        assert!(EDIT_MENU_ACTIONS.contains(&"select_all"));
        assert!(APP_MENU_ACTIONS.contains(&"quit"));
    }
}
