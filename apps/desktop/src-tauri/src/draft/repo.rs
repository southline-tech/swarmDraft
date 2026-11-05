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

    pub fn commit_all(
        &self,
        message: &str,
        committer_name: &str,
        committer_email: &str,
    ) -> Result<Option<String>, DraftRepoError> {
        let mut index = self.repo.index()?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        index.write()?;
        if index.is_empty() {
            return Ok(None);
        }
        let tree_id = index.write_tree()?;
        let tree = self.repo.find_tree(tree_id)?;
        let sig = placeholder_signature(committer_name, committer_email)?;
        let parent = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let oid = if let Some(parent) = parent {
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])?
        } else {
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?
        };
        Ok(Some(oid.to_string()))
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
    ) -> Result<String, DraftRepoError> {
        let old = self.repo.find_commit(parse_oid(oid)?)?;
        let tree = old.tree()?;
        let sig = placeholder_signature(committer_name, committer_email)?;
        let parent = self.repo.head()?.peel_to_commit()?;
        let new_oid = self
            .repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])?;
        self.checkout_head()?;
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
        self.repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            &format!("Merged {branch_name}"),
            &merged,
            &[&main_commit, &bot_commit],
        )?;
        self.repo.set_head("refs/heads/main")?;
        self.checkout_head()?;
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
