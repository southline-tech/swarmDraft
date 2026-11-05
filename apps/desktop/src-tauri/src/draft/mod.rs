//! Git-backed `.draft` file format (#302, partial #116).
//!
//! A `.draft` file is an uncompressed zip containing `manifest.json` and a bare git repo at
//! `repo.git/`. All git operations go through this module so the backend can be swapped later.

mod format;
mod migrate;
mod repo;
mod service;
mod sync;

pub use format::{
    pack_draft, unpack_draft, DraftFormatError, DraftManifest, DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
pub use migrate::{migrate_legacy_books_to_draft, DraftMigrationNotice};
pub use repo::{CommitEntry, DraftRepoError};
pub use service::{DraftRecoveryOffer, DraftSaveOutcome, DraftService, OpenDraftResult};
