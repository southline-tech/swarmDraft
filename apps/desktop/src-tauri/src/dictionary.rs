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

/// Building the curated dictionary merge and the curated `LintGroup` costs far more than linting
/// one paragraph (~200 ms in a debug build), and the editor lints paragraph by paragraph. Keep the
/// last linter and reuse it while the manuscript's word lists are unchanged (#356).
struct CachedLinter {
    extra_words: Vec<String>,
    ignored: Vec<String>,
    dictionary: Arc<MergedDictionary>,
    linter: harper_core::linting::LintGroup,
}

/// Single-entry cache: one manuscript is open at a time, so its word lists rarely change.
struct LinterCache {
    entry: Option<CachedLinter>,
    /// How many times the linter was (re)built; read by tests.
    #[cfg_attr(not(test), allow(dead_code))]
    builds: usize,
}

impl LinterCache {
    const fn new() -> Self {
        Self {
            entry: None,
            builds: 0,
        }
    }

    fn linter(
        &mut self,
        extra_words: &[String],
        ignored: &[String],
    ) -> (&Arc<MergedDictionary>, &mut harper_core::linting::LintGroup) {
        let fresh = self
            .entry
            .as_ref()
            .is_some_and(|c| c.extra_words == extra_words && c.ignored == ignored);
        if !fresh {
            self.builds += 1;
            let dictionary = build_dictionary(extra_words, ignored);
            let linter =
                harper_core::linting::LintGroup::new_curated(dictionary.clone(), Dialect::American);
            self.entry = Some(CachedLinter {
                extra_words: extra_words.to_vec(),
                ignored: ignored.to_vec(),
                dictionary,
                linter,
            });
        }
        let cached = self.entry.as_mut().expect("linter cache filled above");
        (&cached.dictionary, &mut cached.linter)
    }
}

static LINTER_CACHE: std::sync::Mutex<LinterCache> = std::sync::Mutex::new(LinterCache::new());

pub fn lint_plain_text(
    text: &str,
    extra_words: &[String],
    ignored: &[String],
    check_spelling: bool,
    check_grammar: bool,
) -> Vec<SpellLintIssue> {
    let mut cache = LINTER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    lint_with_cache(
        &mut cache,
        text,
        extra_words,
        ignored,
        check_spelling,
        check_grammar,
    )
}

fn lint_with_cache(
    cache: &mut LinterCache,
    text: &str,
    extra_words: &[String],
    ignored: &[String],
    check_spelling: bool,
    check_grammar: bool,
) -> Vec<SpellLintIssue> {
    if text.trim().is_empty() || (!check_spelling && !check_grammar) {
        return Vec::new();
    }
    let source: Vec<char> = text.chars().collect();
    let ignored_set: std::collections::HashSet<&str> = ignored.iter().map(String::as_str).collect();
    let dict_set: std::collections::HashSet<&str> =
        extra_words.iter().map(String::as_str).collect();
    let (dict, linter) = cache.linter(extra_words, ignored);
    let document = Document::new_plain_english(text, dict.as_ref());
    let lints = linter.lint(&document);

    lints
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

/// Async so Tauri runs it off the main thread: a sync command runs on the window's event loop,
/// and linting a whole manuscript paragraph by paragraph kept that thread at 100% and froze
/// input, Save As and Open until it finished (#356).
#[tauri::command]
pub async fn spell_lint_paragraph(
    store: tauri::State<'_, Store>,
    manuscript_id: Option<String>,
    text: String,
    check_spelling: bool,
    check_grammar: bool,
) -> Result<Vec<SpellLintIssue>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
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
        let issues = lint_plain_text("teh", &[], &[], true, false);
        assert!(!issues.is_empty(), "expected a lint for teh");
        assert!(
            issues.iter().all(|i| i.kind == "spelling"),
            "expected Typo lints as spelling, got {:?}",
            issues
        );
    }

    #[test]
    fn ignored_and_dictionary_suppress_typo() {
        let issues = lint_plain_text("teh", &[], &["teh".into()], true, true);
        assert!(issues.is_empty());
        let issues = lint_plain_text("teh", &["teh".into()], &[], true, true);
        assert!(issues.is_empty());
    }

    #[test]
    fn linter_is_built_once_per_word_list() {
        let mut cache = LinterCache::new();
        let words = vec!["zorbnax".to_string()];
        for text in ["One teh paragraph.", "Another paragraph.", "A third tst."] {
            lint_with_cache(&mut cache, text, &words, &[], true, true);
        }
        assert_eq!(
            cache.builds, 1,
            "paragraphs with the same word lists share one linter"
        );
        let issues = lint_with_cache(&mut cache, "teh", &words, &["teh".into()], true, true);
        assert!(issues.is_empty(), "a changed ignore list must take effect");
        assert_eq!(cache.builds, 2);
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
