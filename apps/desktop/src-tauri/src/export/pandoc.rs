//! Invoke Pandoc for EPUB 3 and .docx (#39, #186).
//!
//! Pinned Windows build: Pandoc **3.13** (`pandoc-3.13-windows-x86_64.zip` from the official
//! GitHub release). Downloaded into app data on first export when no override, managed copy, or
//! PATH binary is found. Always run as a separate process (GPL).

#[cfg(any(windows, target_os = "macos"))]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
#[cfg(any(windows, target_os = "macos", test))]
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Pinned Pandoc version for the managed first-export download (#186, #193).
pub const PANDOC_PIN_VERSION: &str = "3.13";

#[cfg(any(windows, target_os = "macos", test))]
const PANDOC_WIN_ZIP_SHA256: &str =
    "23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e";
#[cfg(any(windows, target_os = "macos", test))]
const PANDOC_MAC_ARM64_ZIP_SHA256: &str =
    "f436d18bebbfb3ddd326597686dacab9fac5dc23bd060495020f35a28a43a7c3";
#[cfg(any(windows, target_os = "macos", test))]
const PANDOC_MAC_X64_ZIP_SHA256: &str =
    "1823278715aa405aaf21b59cde5dc789346aa8d4fc307467f9a9ee84162bedc5";

/// Which official Pandoc 3.13 zip to download.
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PandocHost {
    WindowsX64,
    MacosAarch64,
    MacosX86_64,
}

/// One pinned release asset.
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PandocAsset {
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// File name inside the zip (`pandoc.exe` on Windows, `pandoc` on macOS).
    pub exe_name: &'static str,
}

#[cfg(any(windows, target_os = "macos", test))]
pub fn pandoc_asset(host: PandocHost) -> PandocAsset {
    match host {
        PandocHost::WindowsX64 => PandocAsset {
            version: PANDOC_PIN_VERSION,
            url: "https://github.com/jgm/pandoc/releases/download/3.13/pandoc-3.13-windows-x86_64.zip",
            sha256: PANDOC_WIN_ZIP_SHA256,
            exe_name: "pandoc.exe",
        },
        PandocHost::MacosAarch64 => PandocAsset {
            version: PANDOC_PIN_VERSION,
            url: "https://github.com/jgm/pandoc/releases/download/3.13/pandoc-3.13-arm64-macOS.zip",
            sha256: PANDOC_MAC_ARM64_ZIP_SHA256,
            exe_name: "pandoc",
        },
        PandocHost::MacosX86_64 => PandocAsset {
            version: PANDOC_PIN_VERSION,
            url: "https://github.com/jgm/pandoc/releases/download/3.13/pandoc-3.13-x86_64-macOS.zip",
            sha256: PANDOC_MAC_X64_ZIP_SHA256,
            exe_name: "pandoc",
        },
    }
}

/// Asset for this process, if first-export download is supported here.
#[cfg(any(windows, target_os = "macos", test))]
pub fn current_pandoc_host() -> Option<PandocHost> {
    if cfg!(windows) {
        Some(PandocHost::WindowsX64)
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(PandocHost::MacosAarch64)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(PandocHost::MacosX86_64)
    } else {
        None
    }
}

pub const PANDOC_MISSING: &str =
    "Pandoc is not available for export. Connect to the internet and try again, or choose an existing Pandoc in Export settings.";

pub const PDF_NOT_IN_BUILD: &str =
    "PDF export is not in this build yet. Use EPUB or .docx, or wait for the Typst print slice.";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PandocDownloadStatus {
    pub active: bool,
    pub phase: Option<String>,
    pub percent: Option<u8>,
    pub message: Option<String>,
}

#[derive(Clone, Default)]
pub struct PandocDownloadState {
    inner: Arc<Mutex<PandocDownloadStatus>>,
}

impl PandocDownloadState {
    pub fn snapshot(&self) -> PandocDownloadStatus {
        self.inner.lock().expect("pandoc download poisoned").clone()
    }

    pub fn clear(&self) {
        *self.inner.lock().expect("pandoc download poisoned") = PandocDownloadStatus::default();
    }

    pub fn report(&self, phase: &str, percent: Option<u8>, message: &str) {
        let mut st = self.inner.lock().expect("pandoc download poisoned");
        st.active = true;
        st.phase = Some(phase.to_string());
        st.percent = percent;
        st.message = Some(message.to_string());
    }
}

pub fn managed_pandoc_exe(data_dir: &Path) -> PathBuf {
    data_dir
        .join("pandoc")
        .join(PANDOC_PIN_VERSION)
        .join(if cfg!(windows) {
            "pandoc.exe"
        } else {
            "pandoc"
        })
}

fn locate_on_path() -> Result<PathBuf, String> {
    let names = if cfg!(windows) {
        ["pandoc.exe", "pandoc"]
    } else {
        ["pandoc", "pandoc.exe"]
    };
    for dir in std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        for name in names {
            let p = dir.join(name);
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err(PANDOC_MISSING.into())
}

/// Legacy helper: PATH only (tests and MCP guards).
pub fn locate_pandoc() -> Result<PathBuf, String> {
    locate_on_path()
}

pub fn resolve_pandoc(
    data_dir: &Path,
    user_override: Option<&Path>,
    progress: Option<&PandocDownloadState>,
) -> Result<PathBuf, String> {
    if let Some(p) = user_override {
        let trimmed = p.to_string_lossy().trim().to_string();
        if trimmed.is_empty() {
            return Err("pandoc: override: choose a Pandoc program or clear the override.".into());
        }
        let path = PathBuf::from(trimmed);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "pandoc: override: could not find Pandoc at {}",
            path.display()
        ));
    }

    let managed = managed_pandoc_exe(data_dir);
    if managed.is_file() {
        return Ok(managed);
    }

    if let Ok(p) = locate_on_path() {
        return Ok(p);
    }

    #[cfg(any(windows, target_os = "macos"))]
    {
        return download_managed_pandoc(data_dir, progress);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = progress;
        Err(PANDOC_MISSING.into())
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

#[cfg(any(windows, target_os = "macos"))]
fn download_managed_pandoc(
    data_dir: &Path,
    progress: Option<&PandocDownloadState>,
) -> Result<PathBuf, String> {
    let Some(host) = current_pandoc_host() else {
        return Err(PANDOC_MISSING.into());
    };
    let asset = pandoc_asset(host);
    if let Some(p) = progress {
        p.report("downloading", Some(0), "Downloading Pandoc…");
    }

    let bytes = match fetch_url(asset.url, progress) {
        Ok(b) => b,
        Err(e) => {
            if let Some(p) = progress {
                p.clear();
            }
            return Err(e);
        }
    };

    if let Some(p) = progress {
        p.report("verifying", Some(95), "Verifying download…");
    }
    let digest = hex_sha256(&bytes);
    if !digest.eq_ignore_ascii_case(asset.sha256) {
        if let Some(p) = progress {
            p.clear();
        }
        return Err(
            "pandoc: checksum: the Pandoc download did not pass verification. Try again.".into(),
        );
    }

    if let Some(p) = progress {
        p.report("extracting", Some(98), "Installing Pandoc…");
    }
    let install_dir = data_dir.join("pandoc").join(PANDOC_PIN_VERSION);
    std::fs::create_dir_all(&install_dir).map_err(|e| format!("pandoc: extract: {e}"))?;
    let exe = extract_pandoc_bin_from_zip(&bytes, &install_dir, asset.exe_name).map_err(|e| {
        let _ = std::fs::remove_dir_all(install_dir.parent().unwrap_or(&install_dir));
        format!("pandoc: extract: {e}")
    })?;

    if let Some(p) = progress {
        p.clear();
    }
    Ok(exe)
}

#[cfg(any(windows, target_os = "macos"))]
fn fetch_url(url: &str, progress: Option<&PandocDownloadState>) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("pandoc: offline: {e}"))?;
    let mut resp = client.get(url).send().map_err(|e| {
        format!("pandoc: offline: could not download Pandoc ({e}). Try again when online.")
    })?;
    if !resp.status().is_success() {
        return Err(format!(
            "pandoc: offline: download failed (HTTP {}). Try again when online.",
            resp.status()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("pandoc: offline: download interrupted ({e}). Try again."))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        downloaded += n as u64;
        if let (Some(p), true) = (progress, total > 0) {
            let pct = ((downloaded.saturating_mul(100)) / total).min(94) as u8;
            p.report("downloading", Some(pct), "Downloading Pandoc…");
        }
    }
    Ok(out)
}

#[cfg(any(windows, target_os = "macos", test))]
fn zip_entry_is_bin(name: &str, exe_name: &str) -> bool {
    let name = name.trim_end_matches('/');
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base == exe_name
}

#[cfg(any(windows, target_os = "macos", test))]
fn extract_pandoc_bin_from_zip(
    zip_bytes: &[u8],
    dest_dir: &Path,
    exe_name: &str,
) -> Result<PathBuf, String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("invalid zip: {e}"))?;
    let mut best: Option<(u64, PathBuf)> = None;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if file.is_dir() || !zip_entry_is_bin(&name, exe_name) {
            continue;
        }
        let len = file.size();
        if best.as_ref().is_some_and(|(n, _)| *n >= len) {
            continue;
        }
        let out = dest_dir.join(exe_name);
        let mut tmp = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut tmp).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&out)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&out, perms).map_err(|e| e.to_string())?;
        }
        best = Some((len, out));
    }
    best.map(|(_, path)| path)
        .ok_or_else(|| format!("{exe_name} not found in the release zip"))
}

pub fn write_theme_css(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("theme.css");
    std::fs::write(&path, include_str!("assets/theme.css")).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn write_reference_docx(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("reference.docx");
    if path.is_file() {
        return Ok(path);
    }
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in REFERENCE_DOCX_FILES {
        zip.start_file(*name, opts).map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(path)
}

const REFERENCE_DOCX_FILES: &[(&str, &str)] = &[
    (
        "[Content_Types].xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#,
    ),
    (
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
    ),
    (
        "word/_rels/document.xml.rels",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
    ),
    (
        "word/document.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>Reference</w:t></w:r></w:p></w:body>
</w:document>"#,
    ),
    (
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>"#,
    ),
];

pub fn run_pandoc(
    pandoc: &Path,
    markdown: &Path,
    output: &Path,
    format: &str,
    css: &Path,
    reference: &Path,
    author: Option<&str>,
) -> Result<String, String> {
    let mut cmd = Command::new(pandoc);
    cmd.arg(markdown)
        .arg("--standalone")
        .arg("--from=markdown+raw_html+fenced_divs");
    if let Some(a) = author {
        let a = a.trim();
        if !a.is_empty() {
            cmd.arg(format!("--metadata=author={a}"));
        }
    }
    match format {
        "epub" => {
            cmd.arg("--to=epub3")
                .arg(format!("--css={}", css.display()))
                .arg("--toc")
                .arg("--toc-depth=2")
                .arg("--split-level=1");
        }
        "docx" => {
            cmd.arg("--to=docx")
                .arg(format!("--reference-doc={}", reference.display()));
        }
        other => return Err(format!("unsupported export format: {other}")),
    }
    cmd.arg("-o").arg(output);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            PANDOC_MISSING.to_string()
        } else {
            e.to_string()
        }
    })?;
    let log = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() && output.is_file() {
        Ok(log)
    } else if log.is_empty() {
        Err("Pandoc failed to create the export file.".into())
    } else {
        Err(log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reference_docx_is_valid_zip() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_reference_docx(dir.path()).unwrap();
        assert!(path.is_file());
        assert!(zip::ZipArchive::new(std::fs::File::open(path).unwrap())
            .unwrap()
            .file_names()
            .next()
            .is_some());
    }

    #[test]
    fn resolve_prefers_override_over_managed() {
        let dir = tempfile::tempdir().unwrap();
        let managed = managed_pandoc_exe(dir.path());
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::fs::write(&managed, b"managed").unwrap();
        let override_path = dir.path().join("custom.exe");
        std::fs::write(&override_path, b"custom").unwrap();
        let got = resolve_pandoc(dir.path(), Some(&override_path), None).unwrap();
        assert_eq!(got, override_path);
    }

    #[test]
    fn resolve_prefers_managed_over_path() {
        let dir = tempfile::tempdir().unwrap();
        let managed = managed_pandoc_exe(dir.path());
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::fs::write(&managed, b"managed").unwrap();
        let got = resolve_pandoc(dir.path(), None, None).unwrap();
        assert_eq!(got, managed);
    }

    #[test]
    fn checksum_mismatch_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let mut zip =
            zip::ZipWriter::new(std::fs::File::create(dir.path().join("tiny.zip")).unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file("pandoc-3.13/pandoc.exe", opts).unwrap();
        zip.write_all(b"not pandoc").unwrap();
        zip.finish().unwrap();
        let bytes = std::fs::read(dir.path().join("tiny.zip")).unwrap();
        assert!(hex_sha256(&bytes) != PANDOC_WIN_ZIP_SHA256);
    }

    #[test]
    fn extract_finds_pandoc_exe_in_zip() {
        let dir = tempfile::tempdir().unwrap();
        let mut zip =
            zip::ZipWriter::new(std::fs::File::create(dir.path().join("rel.zip")).unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file("pandoc-3.13/pandoc.exe", opts).unwrap();
        zip.write_all(b"fake").unwrap();
        zip.finish().unwrap();
        let bytes = std::fs::read(dir.path().join("rel.zip")).unwrap();
        let dest = dir.path().join("install");
        std::fs::create_dir_all(&dest).unwrap();
        let exe = extract_pandoc_bin_from_zip(&bytes, &dest, "pandoc.exe").unwrap();
        assert!(exe.ends_with("pandoc.exe"));
        assert!(exe.is_file());
    }

    #[test]
    fn pinned_assets_cover_windows_and_both_macos_arches() {
        let win = pandoc_asset(PandocHost::WindowsX64);
        let arm = pandoc_asset(PandocHost::MacosAarch64);
        let intel = pandoc_asset(PandocHost::MacosX86_64);
        assert_eq!(win.version, PANDOC_PIN_VERSION);
        assert_eq!(arm.version, PANDOC_PIN_VERSION);
        assert!(win.url.ends_with("pandoc-3.13-windows-x86_64.zip"));
        assert!(arm.url.ends_with("pandoc-3.13-arm64-macOS.zip"));
        assert!(intel.url.ends_with("pandoc-3.13-x86_64-macOS.zip"));
        assert_eq!(win.exe_name, "pandoc.exe");
        assert_eq!(arm.exe_name, "pandoc");
        assert_eq!(intel.exe_name, "pandoc");
        assert_eq!(win.sha256, PANDOC_WIN_ZIP_SHA256);
        assert_ne!(arm.sha256, intel.sha256);
        assert_ne!(arm.sha256, win.sha256);
        assert_eq!(arm.sha256.len(), 64);
        assert_eq!(intel.sha256.len(), 64);
    }

    #[test]
    fn current_host_matches_this_process() {
        let host = current_pandoc_host();
        #[cfg(windows)]
        assert_eq!(host, Some(PandocHost::WindowsX64));
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(host, Some(PandocHost::MacosAarch64));
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        assert_eq!(host, Some(PandocHost::MacosX86_64));
        #[cfg(not(any(windows, target_os = "macos")))]
        assert_eq!(host, None);
    }

    #[test]
    fn extract_finds_macos_pandoc_not_the_lua_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let mut zip =
            zip::ZipWriter::new(std::fs::File::create(dir.path().join("mac.zip")).unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file("pandoc-3.13-arm64/bin/pandoc-lua", opts)
            .unwrap();
        zip.write_all(b"pandoc").unwrap();
        zip.start_file("pandoc-3.13-arm64/bin/pandoc", opts)
            .unwrap();
        zip.write_all(b"real-pandoc-binary").unwrap();
        zip.finish().unwrap();
        let bytes = std::fs::read(dir.path().join("mac.zip")).unwrap();
        let dest = dir.path().join("install");
        std::fs::create_dir_all(&dest).unwrap();
        let bin = extract_pandoc_bin_from_zip(&bytes, &dest, "pandoc").unwrap();
        assert!(bin.ends_with("pandoc"));
        assert!(!bin.ends_with("pandoc-lua"));
        assert_eq!(std::fs::read(&bin).unwrap(), b"real-pandoc-binary");
    }

    #[test]
    fn download_status_tracks_progress() {
        let state = PandocDownloadState::default();
        state.report("downloading", Some(40), "Downloading Pandoc…");
        let snap = state.snapshot();
        assert!(snap.active);
        assert_eq!(snap.percent, Some(40));
        state.clear();
        assert!(!state.snapshot().active);
    }
}
