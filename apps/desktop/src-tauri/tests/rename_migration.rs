//! #43: an existing pre-rename install opens intact under the new app identifier, and the old
//! data folder is left exactly as it was. Synthetic text only.

use serde_json::json;
use std::path::Path;
use swarmdraft_lib::{
    content,
    manuscripts::ImportSection,
    migrate::{self, Outcome, OLD_IDENTIFIER},
    storage::Store,
};

fn sec(id: &str, kind: &str, title: &str, text: &str) -> ImportSection {
    ImportSection {
        id: Some(id.into()),
        parent_id: None,
        kind: kind.into(),
        title: title.into(),
        doc: json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},
            "content":[{"type":"text","text":text}]}]}),
    }
}

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    fn walk(base: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut v: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap()).collect();
        v.sort_by_key(|e| e.file_name());
        for e in v {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

#[test]
fn existing_install_opens_intact_under_new_identifier() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join(OLD_IDENTIFIER);
    let new = root.path().join("com.radiancelux.swarmdraft");
    assert_eq!(migrate::old_dir_for(&new).unwrap(), old);

    // An existing install: a manuscript with front matter and a non-ASCII chapter, an agent,
    // and an attachment in files/.
    let (mid, docs) = {
        let store = Store::open(&old).unwrap();
        store.create_agent("Sample Agent", "#3366ff").unwrap();
        let (m, secs) = store
            .import_manuscript(
                "Synthetic Harbor",
                &[
                    sec("t", "front_matter", "Title Page", "Synthetic Harbor"),
                    sec(
                        "c1",
                        "chapter",
                        "Chapter One",
                        "naïve café — 😀 at the quay.",
                    ),
                ],
            )
            .unwrap();
        (m.id, secs.into_iter().map(|s| s.doc_id).collect::<Vec<_>>())
    };
    std::fs::create_dir_all(old.join("files")).unwrap();
    std::fs::write(old.join("files/cover.png"), [137u8, 80, 78, 71]).unwrap();
    let before = files(&old);

    assert_eq!(migrate::migrate(&old, &new).unwrap(), Outcome::Copied);
    assert_eq!(files(&old), before, "old folder must be untouched");
    assert!(new.join(swarmdraft_lib::storage::DB_FILENAME).is_file());

    let store = Store::open(&new).unwrap();
    let ms = store.list_manuscripts().unwrap();
    assert_eq!(ms.len(), 1);
    assert_eq!(ms[0].id, mid);
    let loaded = store.load_manuscript(&mid).unwrap();
    let titles: Vec<_> = loaded
        .sections
        .iter()
        .map(|s| s.section.title.clone())
        .collect();
    assert_eq!(titles, ["Title Page", "Chapter One"]);
    let text = content::read_view(&content::decode(&store.load_doc(&docs[1]).unwrap())).text;
    assert_eq!(text, "naïve café — 😀 at the quay.");
    assert_eq!(store.list_agents().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(new.join("files/cover.png")).unwrap(),
        [137u8, 80, 78, 71]
    );

    // Writing under the new identifier never reaches the old folder, and a second start is a no-op.
    store
        .import_manuscript("Second Book", &[sec("x", "chapter", "One", "New text.")])
        .unwrap();
    drop(store);
    assert_eq!(
        files(&old),
        before,
        "old folder changed after using the new one"
    );
    assert_eq!(
        migrate::migrate(&old, &new).unwrap(),
        Outcome::AlreadyPresent
    );
    assert_eq!(
        Store::open(&new).unwrap().list_manuscripts().unwrap().len(),
        2
    );
}
