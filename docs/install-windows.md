# Installing the swarmDraft dev build on Windows

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
  template for tauri-cli 2.12.4. Changes are marked `coAuthor:`. All three pages are full-window
  with the light `--ct-*` colours. Titles use Literata (bundled, see below), falling back to
  Segoe UI Variable / Segoe UI if the font can't be loaded; body text is Segoe UI. Cancel sits on
  the left and the primary button (**Install**, **Finish**) on the right; Back is hidden.
  - Welcome (ob1): Ribbon tile, title, lead line, **Install**. There is no install location page
    for per-user installs.
  - Progress (ob2): Ribbon tile, "Installing swarmDraft…", the ob2 line and one accent progress bar.
    Only Cancel shows. No file log or output-folder text. It moves to the finish page by itself
    when the install ends.
  - Finish (ob3): check tile, "swarmDraft is ready", **Open swarmDraft now** (ticked) and **Finish**.
    The desktop shortcut is always created; there is no checkbox for it.
- `installer-pages.nsh`: installer hook; only tells the template where the page art is.
- `ob-logo.bmp`, `ob-check.bmp`, `nsis-header.bmp`, `nsis-sidebar.bmp`: Ribbon page art.
- `fonts/Literata-Regular.ttf`: title font, loaded privately for the installer process only
  (not installed on the system). SIL Open Font License 1.1, text in `fonts/Literata-OFL.txt`.

Passive (`/P`), silent (`/S`) and update (`/UPDATE`) installs skip the welcome and finish pages as
before. Passive and silent installs always create the desktop shortcut too; updates and `/NS`
leave shortcuts alone. When the Tauri CLI is upgraded, diff its `installer.nsi` against ours and
carry the changes over.

Known gaps versus the mockups (limits of Win32 dialogs):

- Native buttons: not rounded and not accent-filled. NSIS's main window doesn't support owner-drawn
  buttons, and bitmap buttons don't scale with DPI, so the primary button stays a standard button.
- No "About N seconds left" on the progress page: NSIS has no reliable time estimate, so there is
  no time text rather than a wrong one.
- The © line is hidden on the installer pages. The exe's file properties still carry
  "© 2026 Radiance Lux Technologies LLC". The Windows title bar is native.
- Checked by compiling with `makensis -WX` on Linux against Tauri's real include files and plugin,
  and by running the installer (interactive, `/P`, `/S`) under Wine. Not yet run on Windows.

## Uninstalling

Uninstall swarmDraft from **Settings > Apps > Installed apps > swarmDraft > Uninstall**.

The uninstaller shows a **Delete the application data** checkbox, unchecked by default.

- Unticked: everything swarmDraft stored stays on your computer (manuscripts, settings, agent tokens).
- Ticked: it also deletes both `com.radiancelux.coauthor` folders,
  `%APPDATA%\com.radiancelux.coauthor\` (roaming, including `coauthor.db`) and
  `%LOCALAPPDATA%\com.radiancelux.coauthor\` (local). This cannot be undone.
