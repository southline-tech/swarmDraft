# Installing the coAuthor dev build on Windows

The P1 builds are **unsigned**. Code signing is deferred until a certificate is approved.

1. Open the latest successful **CI** run on `main` (Actions tab) and download the
   `coauthor-windows-unsigned-<sha>` artifact. Unzip it.
2. Run either installer:
   - `coAuthor_<version>_x64_en-US.msi` (MSI), or
   - `coAuthor_<version>_x64-setup.exe` (NSIS).
3. Windows SmartScreen will show **"Windows protected your PC"** / unknown publisher, because the
   build is unsigned. Click **More info** then **Run anyway**.
4. If WebView2 is missing (rare on Windows 10/11), the installer downloads it.

Data is stored locally in `%APPDATA%\com.radiancelux.coauthor\` (`coauthor.db`, SQLite).
Uninstall from Settings > Apps; the data folder is kept unless deleted by hand.

The local MCP server listens on `127.0.0.1` only (default port 7337); agent tokens are managed in
the app (RAD-205/209).
