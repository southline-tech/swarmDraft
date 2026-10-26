# Installing the coAuthor dev build on Windows

The P1 builds are **unsigned**. Code signing is deferred until a certificate is approved.

1. Open the latest successful **CI** run on `main` (Actions tab) and download the
   `coauthor-windows-unsigned-<sha>` artifact. Unzip it.
2. The zip contains two subfolders; run either installer:
   - `msi/coAuthor_<version>_x64_en-US.msi` (MSI), or
   - `nsis/coAuthor_<version>_x64-setup.exe` (NSIS).
3. Windows SmartScreen will show **"Windows protected your PC"** / unknown publisher, because the
   build is unsigned. Click **More info** then **Run anyway**.
4. If WebView2 is missing (rare on Windows 10/11), the installer downloads it.

Data is stored locally in `%APPDATA%\com.radiancelux.coauthor\` (`coauthor.db`, SQLite).
Uninstalling keeps it unless you tick **Delete the application data** in the uninstaller (see
[Uninstalling](#uninstalling)).

The local MCP server listens on `127.0.0.1` only (default port 7337); agent tokens are managed in
the app (RAD-205/209).

## Installer pages (issue #61)

The NSIS installer installs **per user** (`installMode: currentUser`): no admin prompt, files go to
`%LOCALAPPDATA%\coAuthor`. Pages follow mockups ob1 to ob3. Everything lives in
`apps/desktop/src-tauri/windows/`:

- `installer.nsi`: custom template (`bundle.windows.nsis.template`), a copy of Tauri's default
  template for tauri-cli 2.12.4. Changes are marked `coAuthor:`. It has nsDialogs welcome and
  finish pages with the light `--ct-*` colours and Segoe UI Variable (Segoe UI on Windows 10). The
  welcome button reads **Install**. There is no install location page for per-user installs, and
  the progress page uses the ob2 copy. The finish page has **Open coAuthor now** and **Create
  desktop shortcut**, both ticked.
- `installer-pages.nsh`: installer hook; only tells the template where the page art is.
- `ob-logo.bmp`, `ob-check.bmp`, `nsis-header.bmp`, `nsis-sidebar.bmp`: Ribbon page art.

Passive (`/P`), silent (`/S`) and update (`/UPDATE`) installs skip the welcome and finish pages as
before; passive and silent installs still create the desktop shortcut. When the Tauri CLI is
upgraded, diff its `installer.nsi` against ours and carry the changes over.

Known gaps versus the mockups (limits of Win32 dialogs):

- Native buttons: not rounded, not accent-filled, and Cancel sits beside Install, not before it.
- Title type is Segoe UI semibold, not the manuscript serif. The Windows title bar is native.
- The progress page keeps the MUI header strip (title, subtitle and Ribbon header art) above the
  bar, and has no big logo tile. The status line shows NSIS file progress, not "About 30 seconds
  left".
- After the progress bar finishes you click **Next** to reach the finish page.
- The finish page has an extra **Create desktop shortcut** checkbox.
- Checked only by compiling with `makensis -WX` on Linux against Tauri's real include files and
  plugin. Not yet run on Windows.

## Uninstalling

Uninstall coAuthor from **Settings > Apps > Installed apps > coAuthor > Uninstall**.

The uninstaller shows a **Delete the application data** checkbox, unchecked by default.

- Unticked: everything coAuthor stored stays on your computer (manuscripts, settings, agent tokens).
- Ticked: it also deletes both `com.radiancelux.coauthor` folders,
  `%APPDATA%\com.radiancelux.coauthor\` (roaming, including `coauthor.db`) and
  `%LOCALAPPDATA%\com.radiancelux.coauthor\` (local). This cannot be undone.
