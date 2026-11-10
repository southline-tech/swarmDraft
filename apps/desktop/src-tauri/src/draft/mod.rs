//! Git-backed `.draft` file format (#302, #116).
//!
//! A `.draft` file is an uncompressed zip containing `manifest.json` and a bare git repo at
//! `repo.git/`. All git operations go through this module so the backend can be swapped later.
//! Worktree layout, trailers, and sync points are described in `docs/git-backbone.md`.

mod changes;
mod format;
mod migrate;
mod repair;
mod repo;
mod service;
mod sessions;
mod sync;

pub use changes::DraftChangeResolve;
pub use format::{
    pack_draft, unpack_draft, DraftFormatError, DraftManifest, DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
pub use migrate::{migrate_legacy_books_to_draft, DraftMigrationNotice};
pub use repair::repair_draft_file_paths;
pub use repo::{CommitEntry, CommitOptions, DraftRepo, DraftRepoError};
pub use service::{
    commit_comment_mutation, queue_main_commit, DraftRecoveryOffer, DraftSaveOutcome, DraftService,
    OpenDraftResult,
};
