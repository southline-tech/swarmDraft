//! Every Yjs doc must use UTF-16 offsets (`content::new_doc`). clippy.toml bans `yrs::Doc::new`;
//! clippy can't target a single type's `Default` impl, so this scans the sources for
//! `Doc::default` and the other non-UTF-16 constructors.

fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn no_non_utf16_doc_constructors() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rs_files(&root.join("src"), &mut files);
    rs_files(&root.join("tests"), &mut files);
    let banned = [
        ["Doc", "::default("].concat(),
        ["Doc", "::new("].concat(),
        ["Doc", "::with_client_id("].concat(),
        ["Doc: ", "Default::default"].concat(),
    ];
    let mut hits = Vec::new();
    for f in files {
        for (i, line) in std::fs::read_to_string(&f).unwrap().lines().enumerate() {
            if banned.iter().any(|b| line.contains(b.as_str())) {
                hits.push(format!("{}:{}: {}", f.display(), i + 1, line.trim()));
            }
        }
    }
    assert!(
        hits.is_empty(),
        "use content::new_doc():\n{}",
        hits.join("\n")
    );
}
