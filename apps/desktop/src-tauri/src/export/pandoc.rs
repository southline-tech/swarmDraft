//! Invoke Pandoc for EPUB 3 and .docx (#39).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub const PANDOC_MISSING: &str =
    "Pandoc is not installed. Install Pandoc from https://pandoc.org/ and try again.";

pub const PDF_NOT_IN_BUILD: &str =
    "PDF export is not in this build yet. Use EPUB or .docx, or wait for the Typst print slice.";

pub fn locate_pandoc() -> Result<PathBuf, String> {
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
) -> Result<String, String> {
    let mut cmd = Command::new(pandoc);
    cmd.arg(markdown)
        .arg("--standalone")
        .arg("--from=markdown+raw_html+fenced_divs")
        .arg("--metadata=author=Author");
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
}
