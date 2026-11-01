//! Cross-language Yjs round trip with UTF-16 offsets; see
//! packages/editor/src/rust-roundtrip.test.ts for the TS half and how to regenerate.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use swarmdraft_lib::content::{decode, encode, new_doc, validate_doc};
use yrs::{updates::decoder::Decode, ReadTxn, StateVector, Transact, Update};

fn path(f: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/mcp/roundtrip")
        .join(f)
}

fn read(f: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path(f)).unwrap()).unwrap()
}

fn as_doc(d: &yrs::Doc) -> Value {
    let blocks: Vec<Value> = decode(d).into_iter().map(|b| b.node).collect();
    json!({ "type": "doc", "content": blocks })
}

#[test]
fn roundtrip_fixture() {
    let secs = read("sections.json");
    let secs = secs.as_array().unwrap();
    assert!(secs.len() >= 22, "{}", secs.len());
    let mut rust = Vec::new();
    for (i, s) in secs.iter().enumerate() {
        validate_doc(s).unwrap();
        // Rust -> Rust
        let d = new_doc();
        encode(&d, s).unwrap();
        assert_eq!(as_doc(&d), *s, "rust round trip, section {i}");
        rust.push(
            STANDARD.encode(
                d.transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            ),
        );
    }
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(
            path("rust-updates.json"),
            serde_json::to_string(&rust).unwrap() + "\n",
        )
        .unwrap();
    }
    // TS -> Rust, and the committed Rust updates (which the TS test opens in the editor).
    for file in ["ts-updates.json", "rust-updates.json"] {
        let ups = read(file);
        let ups = ups.as_array().unwrap();
        assert_eq!(ups.len(), secs.len(), "{file}");
        for (i, (u, s)) in ups.iter().zip(secs).enumerate() {
            let d = new_doc();
            let bytes = STANDARD.decode(u.as_str().unwrap()).unwrap();
            d.transact_mut()
                .apply_update(Update::decode_v1(&bytes).unwrap())
                .unwrap();
            assert_eq!(as_doc(&d), *s, "{file}, section {i}");
        }
    }
}
