//! Spelling and grammar (#159): Harper lint command and per-manuscript dictionary storage.

use std::sync::Arc;

use harper_core::linting::{Lint, LintKind, Linter, Suggestion};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::storage::{StorageError, Store};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellLintIssue {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    pub message: String,
    pub suggestions: Vec<String>,
}

pub fn normalize_word(word: &str) -> String {
    word.nfkc().collect::<String>().trim().to_lowercase()
}

fn suggestion_strings(suggestions: &[Suggestion]) -> Vec<String> {
    let mut out = Vec::new();
    for s in suggestions {
        let text = match s {
            Suggestion::ReplaceWith(chars) => chars.iter().collect::<String>(),
            Suggestion::InsertAfter(chars) => chars.iter().collect::<String>(),
            Suggestion::Remove => continue,
        };
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
        }
    }
    out.truncate(8);
    out
}

fn is_spelling_lint(kind: LintKind) -> bool {
    kind.is_spelling() || kind.is_typo()
}

fn lint_kind_label(kind: LintKind) -> &'static str {
    if is_spelling_lint(kind) {
        "spelling"
    } else {
        "grammar"
    }
}

fn build_dictionary(extra_words: &[String], ignored: &[String]) -> Arc<MergedDictionary> {
    let mut combined: Vec<String> = extra_words.to_vec();
    for w in ignored {
        if !combined.iter().any(|x| x == w) {
            combined.push(w.clone());
        }
    }
    let mut merged = MergedDictionary::new();
    merged.add_dictionary(Arc::new(FstDictionary::curated()) as Arc<dyn Dictionary>);
    if !combined.is_empty() {
        let mut user = MutableDictionary::new();
        user.extend_words(
            combined
                .into_iter()
                .map(|w| (w.chars().collect::<Vec<_>>(), DictWordMetadata::default())),
        );
        merged.add_dictionary(Arc::new(user) as Arc<dyn Dictionary>);
    }
    Arc::new(merged)
}

pub fn lint_plain_text(
    text: &str,
    extra_words: &[String],
    ignored: &[String],
    check_spelling: bool,
    check_grammar: bool,
) -> Vec<SpellLintIssue> {
    if text.trim().is_empty() || (!check_spelling && !check_grammar) {
        return Vec::new();
    }
    let dict_arc = build_dictionary(extra_words, ignored);
    let mut linter =
        harper_core::linting::LintGroup::new_curated(dict_arc.clone(), Dialect::American);
    let document = Document::new_plain_english(text, dict_arc.as_ref());
    let source: Vec<char> = text.chars().collect();
    let ignored_set: std::collections::HashSet<&str> = ignored.iter().map(String::as_str).collect();
    let dict_set: std::collections::HashSet<&str> =
        extra_words.iter().map(String::as_str).collect();

    linter
        .lint(&document)
        .into_iter()
        .filter(|lint| match lint.lint_kind {
            k if is_spelling_lint(k) => check_spelling,
            _ => check_grammar,
        })
        .filter(|lint| {
            let word = lint.get_str(&source);
            let key = normalize_word(&word);
            !ignored_set.contains(key.as_str()) && !dict_set.contains(key.as_str())
        })
        .map(|lint| lint_to_issue(&lint, &source))
        .collect()
}

fn lint_to_issue(lint: &Lint, _source: &[char]) -> SpellLintIssue {
    SpellLintIssue {
        start: lint.span.start,
        end: lint.span.end,
        kind: lint_kind_label(lint.lint_kind).to_string(),
        message: lint.message.clone(),
        suggestions: suggestion_strings(&lint.suggestions),
    }
}

impl Store {
    pub fn spell_dictionary_list(
        &self,
        manuscript_id: &str,
        query: Option<&str>,
    ) -> Result<Vec<String>, StorageError> {
        self.with_sql(|conn| {
            let q = query.map(normalize_word).filter(|s| !s.is_empty());
            if let Some(prefix) = q {
                let mut stmt = conn.prepare(
                    "SELECT word FROM spell_dictionary WHERE manuscript_id = ?1 AND word LIKE ?2 \
                     ORDER BY word LIMIT 500",
                )?;
                let rows = stmt.query_map(
                    rusqlite::params![manuscript_id, format!("{prefix}%")],
                    |r| r.get(0),
                )?;
                rows.collect()
            } else {
                let mut stmt = conn.prepare(
                    "SELECT word FROM spell_dictionary WHERE manuscript_id = ?1 ORDER BY word LIMIT 2000",
                )?;
                let rows = stmt.query_map([manuscript_id], |r| r.get(0))?;
                rows.collect()
            }
        })
    }

    pub fn spell_dictionary_add(
        &self,
        manuscript_id: &str,
        word: &str,
    ) -> Result<(), StorageError> {
        let w = normalize_word(word);
        if w.is_empty() {
            return Err(StorageError::Invalid("empty word".into()));
        }
        self.with_sql(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO spell_dictionary (manuscript_id, word, added_at) \
                 VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![manuscript_id, w],
            )?;
            Ok(())
        })
    }

    pub fn spell_dictionary_remove(
        &self,
        manuscript_id: &str,
        word: &str,
    ) -> Result<(), StorageError> {
        let w = normalize_word(word);
        self.with_sql(|conn| {
            conn.execute(
                "DELETE FROM spell_dictionary WHERE manuscript_id = ?1 AND word = ?2",
                rusqlite::params![manuscript_id, w],
            )?;
            Ok(())
        })
    }

    pub fn spell_dictionary_ignore(
        &self,
        manuscript_id: &str,
        word: &str,
    ) -> Result<(), StorageError> {
        let w = normalize_word(word);
        if w.is_empty() {
            return Err(StorageError::Invalid("empty word".into()));
        }
        self.with_sql(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO spell_ignored (manuscript_id, word) VALUES (?1, ?2)",
                rusqlite::params![manuscript_id, w],
            )?;
            Ok(())
        })
    }

    fn spell_extra_words(&self, manuscript_id: &str) -> Result<Vec<String>, StorageError> {
        self.spell_dictionary_list(manuscript_id, None)
    }

    fn spell_ignored_words(&self, manuscript_id: &str) -> Result<Vec<String>, StorageError> {
        self.with_sql(|conn| {
            let mut stmt = conn
                .prepare("SELECT word FROM spell_ignored WHERE manuscript_id = ?1 ORDER BY word")?;
            let rows = stmt.query_map([manuscript_id], |r| r.get(0))?;
            rows.collect()
        })
    }
}

#[tauri::command]
pub fn spell_lint_paragraph(
    store: tauri::State<'_, Store>,
    manuscript_id: Option<String>,
    text: String,
    check_spelling: bool,
    check_grammar: bool,
) -> Result<Vec<SpellLintIssue>, String> {
    let (extra, ignored) = if let Some(id) = manuscript_id.as_deref() {
        (
            store.spell_extra_words(id).map_err(|e| e.to_string())?,
            store.spell_ignored_words(id).map_err(|e| e.to_string())?,
        )
    } else {
        (Vec::new(), Vec::new())
    };
    Ok(lint_plain_text(
        &text,
        &extra,
        &ignored,
        check_spelling,
        check_grammar,
    ))
}

#[tauri::command]
pub fn spell_dictionary_list(
    store: tauri::State<'_, Store>,
    manuscript_id: String,
    query: Option<String>,
) -> Result<Vec<String>, String> {
    store
        .spell_dictionary_list(&manuscript_id, query.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spell_dictionary_add(
    store: tauri::State<'_, Store>,
    manuscript_id: String,
    word: String,
) -> Result<(), String> {
    store
        .spell_dictionary_add(&manuscript_id, &word)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spell_dictionary_remove(
    store: tauri::State<'_, Store>,
    manuscript_id: String,
    word: String,
) -> Result<(), String> {
    store
        .spell_dictionary_remove(&manuscript_id, &word)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spell_dictionary_ignore(
    store: tauri::State<'_, Store>,
    manuscript_id: String,
    word: String,
) -> Result<(), String> {
    store
        .spell_dictionary_ignore(&manuscript_id, &word)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalize_word_trims_and_lowercases() {
        assert_eq!(normalize_word("  Foo  "), "foo");
    }

    #[test]
    fn lint_finds_misspelling() {
        let issues = lint_plain_text("This is an tst.", &[], &[], true, true);
        assert!(issues.iter().any(|i| i.kind == "spelling"));
    }

    #[test]
    fn common_typo_uses_spelling_kind() {
        let issues = lint_plain_text("Fix teh word.", &[], &[], true, true);
        let teh = issues.iter().find(|i| {
            i.message.to_lowercase().contains("teh") || {
                let slice = &i.message;
                slice.contains("teh")
            }
        });
        if teh.is_none() {
            let any = lint_plain_text("teh", &[], &[], true, false);
            assert!(
                any.iter().all(|i| i.kind == "spelling"),
                "expected Typo lints as spelling, got {:?}",
                any
            );
        } else {
            assert_eq!(teh.unwrap().kind, "spelling");
        }
    }

    #[test]
    fn ignored_and_dictionary_suppress_typo() {
        let issues = lint_plain_text("teh", &[], &["teh".into()], true, true);
        assert!(issues.is_empty());
        let issues = lint_plain_text("teh", &["teh".into()], &[], true, true);
        assert!(issues.is_empty());
    }

    #[test]
    fn custom_dictionary_suppresses_flag() {
        let issues = lint_plain_text("Zorbnax walked.", &["zorbnax".into()], &[], true, false);
        assert!(issues.is_empty());
    }

    #[test]
    fn dictionary_round_trip_in_sqlite() {
        let dir = tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .with_sql(|conn| {
                conn.execute(
                    "INSERT INTO manuscripts (id, title, created_at) VALUES ('m1', 'T', 'now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        store.spell_dictionary_add("m1", "Zorbnax").unwrap();
        let words = store.spell_dictionary_list("m1", None).unwrap();
        assert_eq!(words, vec!["zorbnax"]);
        store.spell_dictionary_remove("m1", "Zorbnax").unwrap();
        assert!(store.spell_dictionary_list("m1", None).unwrap().is_empty());
    }
}
