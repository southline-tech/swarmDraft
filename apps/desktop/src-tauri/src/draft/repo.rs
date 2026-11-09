//! Embedded git (git2-rs) for draft working repos.

use std::path::{Path, PathBuf};

use git2::{BranchType, Commit, Repository, Signature};

use super::format::DraftFormatError;

#[derive(Debug, thiserror::Error)]
pub enum DraftRepoError {
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("format: {0}")]
    Format(#[from] DraftFormatError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub oid: String,
    pub time_unix: i64,
    pub committer_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct CommitOptions {
    /// When false, a tree identical to HEAD is not committed.
    pub allow_empty: bool,
    /// Also move this `refs/heads/…` name (for example `session/<id>`) to the new commit.
    pub advance_branch: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HistoryCommit {
    pub oid: String,
    pub time_unix: i64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct RefTip {
    /// Short name under `refs/heads/` (`main`, `bot/…`, `session/…`).
    pub name: String,
    pub oid: String,
}

pub struct DraftRepo {
    repo: Repository,
    path: PathBuf,
}

impl DraftRepo {
    pub fn init_working(path: &Path) -> Result<Self, DraftRepoError> {
        std::fs::create_dir_all(path)?;
        let repo = if path.join(".git").exists() {
            Repository::open(path)?
        } else {
            Repository::init(path)?
        };
        Ok(Self {
            repo,
            path: path.to_path_buf(),
        })
    }

    pub fn open_working(path: &Path) -> Result<Self, DraftRepoError> {
        let repo = Repository::open(path)?;
        Ok(Self {
            repo,
            path: path.to_path_buf(),
        })
    }

    pub fn head_oid(&self) -> Result<Option<String>, DraftRepoError> {
        Ok(self
            .repo
            .head()
            .ok()
            .and_then(|h| h.target().map(|o| o.to_string())))
    }

    pub fn commit_time_unix(&self, oid: &str) -> Result<i64, DraftRepoError> {
        Ok(self.repo.find_commit(parse_oid(oid)?)?.time().seconds())
    }

    pub fn checkout_branch(&self, branch_name: &str) -> Result<(), DraftRepoError> {
        let reference = format!("refs/heads/{branch_name}");
        let obj = self
            .repo
            .revparse_single(&reference)
            .or_else(|_| self.repo.revparse_single(branch_name))?;
        let tree = obj.peel_to_tree()?;
        self.repo.checkout_tree(
            tree.as_object(),
            Some(
                git2::build::CheckoutBuilder::default()
                    .force()
                    .remove_untracked(true)
                    .remove_ignored(true),
            ),
        )?;
        self.repo.set_head(&reference)?;
        Ok(())
    }

    pub fn checkout_main(&self) -> Result<(), DraftRepoError> {
        if self.repo.find_branch("main", BranchType::Local).is_ok() {
            return self.checkout_branch("main");
        }
        self.checkout_branch("master")
    }

    pub fn commit_all(
        &self,
        message: &str,
        committer_name: &str,
        committer_email: &str,
        options: &CommitOptions,
    ) -> Result<Option<String>, DraftRepoError> {
        let mut index = self.repo.index()?;
        // Older packs left a bare-repo scratch dir inside the worktree. Drop it so it is not committed.
        let scratch = self.path.join(".bare-export");
        if scratch.exists() {
            std::fs::remove_dir_all(&scratch)?;
        }
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        // Stage deletions so a removed comment file does not linger in the next commit.
        index.update_all(["*"].iter(), None)?;
        index.write()?;
        if index.is_empty() {
            return Ok(None);
        }
        let tree_id = index.write_tree()?;
        let tree = self.repo.find_tree(tree_id)?;
        let sig = placeholder_signature(committer_name, committer_email)?;
        let parent = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        if !options.allow_empty {
            if let Some(parent) = &parent {
                if parent.tree_id() == tree_id {
                    return Ok(None);
                }
            }
        }
        let oid = if let Some(parent) = parent {
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])?
        } else {
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?
        };
        if let Some(branch) = &options.advance_branch {
            self.point_branch(branch, &oid.to_string())?;
        }
        Ok(Some(oid.to_string()))
    }

    pub fn head_name(&self) -> Result<Option<String>, DraftRepoError> {
        match self.repo.head() {
            Ok(head) => Ok(head.shorthand().map(|s| s.to_string())),
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn branch_target(&self, branch: &str) -> Result<Option<String>, DraftRepoError> {
        match self.repo.find_reference(&format!("refs/heads/{branch}")) {
            Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Create or move `refs/heads/{branch}` without changing HEAD.
    pub fn point_branch(&self, branch: &str, oid: &str) -> Result<(), DraftRepoError> {
        let reference = format!("refs/heads/{branch}");
        let oid = parse_oid(oid)?;
        match self.repo.find_reference(&reference) {
            Ok(mut existing) => {
                existing.set_target(oid, "advance")?;
            }
            Err(_) => {
                self.repo.reference(&reference, oid, false, "create")?;
            }
        }
        Ok(())
    }

    pub fn commit_message(&self, oid: &str) -> Result<String, DraftRepoError> {
        let commit = self.repo.find_commit(parse_oid(oid)?)?;
        Ok(commit.message().unwrap_or("").to_string())
    }

    pub fn file_bytes(&self, oid: &str, path: &str) -> Result<Option<Vec<u8>>, DraftRepoError> {
        let commit = self.repo.find_commit(parse_oid(oid)?)?;
        let tree = commit.tree()?;
        match tree.get_path(std::path::Path::new(path)) {
            Ok(entry) => {
                let blob = self.repo.find_blob(entry.id())?;
                Ok(Some(blob.content().to_vec()))
            }
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// First-parent history of `tip_oid`, oldest commit first.
    pub fn walk_first_parent(&self, tip_oid: &str) -> Result<Vec<HistoryCommit>, DraftRepoError> {
        let mut commit = self.repo.find_commit(parse_oid(tip_oid)?)?;
        let mut out = Vec::new();
        loop {
            out.push(HistoryCommit {
                oid: commit.id().to_string(),
                time_unix: commit.time().seconds(),
                message: commit.message().unwrap_or("").to_string(),
            });
            if commit.parent_count() == 0 {
                break;
            }
            commit = commit.parent(0)?;
        }
        out.reverse();
        Ok(out)
    }

    /// `main` (or `master`), then `bot/*`, then `session/*`.
    pub fn search_ref_tips(&self) -> Result<Vec<RefTip>, DraftRepoError> {
        let mut out = Vec::new();
        if let Some(oid) = self.branch_target("main")? {
            out.push(RefTip {
                name: "main".into(),
                oid,
            });
        } else if let Some(oid) = self.branch_target("master")? {
            out.push(RefTip {
                name: "master".into(),
                oid,
            });
        }
        let mut extra = Vec::new();
        for reference in self.repo.references()? {
            let reference = reference?;
            let Some(full) = reference.name() else {
                continue;
            };
            let Some(short) = full.strip_prefix("refs/heads/") else {
                continue;
            };
            if short.starts_with("bot/") || short.starts_with("session/") {
                if let Some(oid) = reference.target() {
                    extra.push(RefTip {
                        name: short.to_string(),
                        oid: oid.to_string(),
                    });
                }
            }
        }
        extra.sort_by(|a, b| {
            let rank = |name: &str| if name.starts_with("bot/") { 0 } else { 1 };
            rank(&a.name).cmp(&rank(&b.name)).then(a.name.cmp(&b.name))
        });
        out.extend(extra);
        Ok(out)
    }

    pub fn list_main_commits(
        &self,
        limit: usize,
        skip: usize,
    ) -> Result<Vec<CommitEntry>, DraftRepoError> {
        let mut out = Vec::new();
        let obj = self
            .repo
            .revparse_single("main")
            .or_else(|_| self.repo.revparse_single("HEAD"))?;
        let mut commit = obj.peel_to_commit()?;
        let mut skipped = 0usize;
        while out.len() < limit {
            if skipped < skip {
                skipped += 1;
            } else {
                out.push(commit_to_entry(&commit));
            }
            if commit.parent_count() == 0 {
                break;
            }
            commit = commit.parent(0)?;
        }
        Ok(out)
    }

    pub fn restore_as_new_commit(
        &self,
        oid: &str,
        committer_name: &str,
        committer_email: &str,
        message: &str,
        advance_branch: Option<&str>,
    ) -> Result<String, DraftRepoError> {
        let old = self.repo.find_commit(parse_oid(oid)?)?;
        let tree = old.tree()?;
        let sig = placeholder_signature(committer_name, committer_email)?;
        let parent = self.repo.head()?.peel_to_commit()?;
        let new_oid = self
            .repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])?;
        self.checkout_head()?;
        if let Some(branch) = advance_branch {
            self.point_branch(branch, &new_oid.to_string())?;
        }
        Ok(new_oid.to_string())
    }

    pub fn checkout_head(&self) -> Result<(), DraftRepoError> {
        let head = self.repo.head()?.peel_to_commit()?;
        let tree = head.tree()?;
        self.repo.checkout_tree(
            tree.as_object(),
            Some(
                git2::build::CheckoutBuilder::default()
                    .force()
                    .remove_untracked(true)
                    .remove_ignored(true),
            ),
        )?;
        Ok(())
    }

    pub fn has_branch(&self, branch_name: &str) -> bool {
        self.repo
            .find_branch(branch_name, BranchType::Local)
            .is_ok()
    }

    pub fn ensure_bot_branch(&self, branch_name: &str) -> Result<(), DraftRepoError> {
        if self
            .repo
            .find_branch(branch_name, BranchType::Local)
            .is_ok()
        {
            return Ok(());
        }
        let head = self.repo.head()?.peel_to_commit()?;
        self.repo.branch(branch_name, &head, false)?;
        Ok(())
    }

    pub fn merge_bot_branch(
        &self,
        branch_name: &str,
        committer_name: &str,
        advance_branch: Option<&str>,
    ) -> Result<(), DraftRepoError> {
        let sig = placeholder_signature(committer_name, "author@swarmdraft.local")?;
        let main_commit = self
            .repo
            .find_branch("main", BranchType::Local)
            .or_else(|_| self.repo.find_branch("master", BranchType::Local))?
            .get()
            .peel_to_commit()?;
        let bot_commit = self
            .repo
            .find_branch(branch_name, BranchType::Local)?
            .get()
            .peel_to_commit()?;
        let main_tree = main_commit.tree()?;
        let bot_tree = bot_commit.tree()?;
        let merged_tree = self
            .repo
            .merge_trees(&main_tree, &main_tree, &bot_tree, None)?
            .write_tree_to(&self.repo)?;
        let merged = self.repo.find_tree(merged_tree)?;
        let oid = self.repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            &format!("Merged {branch_name}"),
            &merged,
            &[&main_commit, &bot_commit],
        )?;
        self.repo.set_head("refs/heads/main")?;
        self.checkout_head()?;
        if let Some(branch) = advance_branch {
            self.point_branch(branch, &oid.to_string())?;
        }
        Ok(())
    }

    /// Copy the working repo's `.git` directory into bare layout (`repo.git/` in the zip).
    pub fn export_bare(&self, bare_path: &Path) -> Result<(), DraftRepoError> {
        let git_dir = self.path.join(".git");
        if !git_dir.is_dir() {
            return Err(DraftRepoError::Invalid(
                "working repo has no .git directory".into(),
            ));
        }
        if bare_path.exists() {
            std::fs::remove_dir_all(bare_path)?;
        }
        copy_dir_all(&git_dir, bare_path)?;
        Ok(())
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), DraftRepoError> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn parse_oid(oid: &str) -> Result<git2::Oid, DraftRepoError> {
    git2::Oid::from_str(oid).map_err(|e| DraftRepoError::Invalid(format!("bad commit oid: {e}")))
}

fn commit_to_entry(c: &Commit) -> CommitEntry {
    CommitEntry {
        oid: c.id().to_string(),
        time_unix: c.time().seconds(),
        committer_name: c.committer().name().unwrap_or("Author").to_string(),
        message: c.summary().unwrap_or("").to_string(),
    }
}

fn placeholder_signature(name: &str, email: &str) -> Result<Signature<'static>, DraftRepoError> {
    Ok(Signature::now(name, email)?)
}

/// Append git trailers after a blank line. An existing trailer block is extended in place.
pub fn append_trailers(message: &str, trailers: &[(&str, &str)]) -> String {
    if trailers.is_empty() {
        return message.trim_end().to_string();
    }
    let mut out = message.trim_end().to_string();
    let already = message_trailers(&out);
    if already.is_empty() {
        out.push_str("\n\n");
    } else {
        out.push('\n');
    }
    for (key, value) in trailers {
        let value = value.replace(['\n', '\r'], " ");
        out.push_str(key);
        out.push_str(": ");
        out.push_str(&value);
        out.push('\n');
    }
    out
}

pub fn message_trailers(message: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = message.lines().collect();
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && split_trailer(lines[start - 1]).is_some() {
        start -= 1;
    }
    if start == end {
        return Vec::new();
    }
    if start > 0 && !lines[start - 1].trim().is_empty() {
        return Vec::new();
    }
    lines[start..end]
        .iter()
        .filter_map(|line| split_trailer(line))
        .collect()
}

pub fn trailer_value(trailers: &[(String, String)], key: &str) -> Option<String> {
    trailers
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
}

fn split_trailer(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some((key.to_string(), value.trim().to_string()))
}

#[cfg(test)]
mod trailer_tests {
    use super::{append_trailers, message_trailers, trailer_value};

    #[test]
    fn trailers_stay_off_the_first_line() {
        let msg = append_trailers(
            "Accepted Bot's change in One",
            &[
                ("Change-Id", "abc"),
                ("Decision", "accepted"),
                ("Section", "s1"),
                ("Session", "sess"),
            ],
        );
        assert_eq!(msg.lines().next(), Some("Accepted Bot's change in One"));
        assert!(!msg.lines().next().unwrap().contains("Change-Id"));
        let trailers = message_trailers(&msg);
        assert_eq!(
            trailer_value(&trailers, "Change-Id").as_deref(),
            Some("abc")
        );
        assert_eq!(
            trailer_value(&trailers, "Decision").as_deref(),
            Some("accepted")
        );
        assert_eq!(trailer_value(&trailers, "Section").as_deref(), Some("s1"));
        assert_eq!(trailer_value(&trailers, "Session").as_deref(), Some("sess"));
    }

    #[test]
    fn a_second_trailer_joins_the_same_block() {
        let once = append_trailers("Saved", &[("Change-Id", "abc")]);
        let twice = append_trailers(&once, &[("Session", "sess")]);
        let trailers = message_trailers(&twice);
        assert_eq!(
            trailer_value(&trailers, "Change-Id").as_deref(),
            Some("abc")
        );
        assert_eq!(trailer_value(&trailers, "Session").as_deref(), Some("sess"));
        assert_eq!(twice.matches("\n\n").count(), 1);
    }
}
