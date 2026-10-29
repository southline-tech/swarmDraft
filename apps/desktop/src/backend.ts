import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface AppInfo {
  version: string;
  dataDir: string;
  schemaVersion: number;
  /** OS account name for track-changes profile seeding (#57); present in the desktop app. */
  computerName?: string;
}

/** Ask the Rust side for basic app info; returns null in a plain browser (pnpm dev:web). */
export async function getAppInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null;
  return invoke<AppInfo>('app_info');
}

/** Agent principal (RAD-205). Mirrors `agents::Agent` in Rust. */
export interface Agent {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  revokedAt: string | null;
}

export const AGENT_SCOPES = ['read', 'comment', 'suggest'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export interface TokenInfo {
  id: string;
  agentId: string;
  prefix: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** `token` is only ever returned here, once; the backend stores a hash. */
export interface NewToken {
  token: string;
  info: TokenInfo;
}

export const agentsApi = {
  list: () => invoke<Agent[]>('agents_list'),
  create: (name: string, color: string) => invoke<Agent>('agent_create', { name, color }),
  revoke: (agentId: string) => invoke<void>('agent_revoke', { agentId }),
  tokens: (agentId: string) => invoke<TokenInfo[]>('agent_tokens_list', { agentId }),
  createToken: (agentId: string, scopes?: AgentScope[]) =>
    invoke<NewToken>('agent_token_create', { agentId, scopes }),
  revokeToken: (tokenId: string) => invoke<void>('agent_token_revoke', { tokenId }),
};
export type AgentsApi = typeof agentsApi;

export interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAtUnix: number;
  files: string[];
}

/**
 * Write a full-project backup. The backend opens the native save dialog itself and builds the
 * archive, so the webview never chooses the path or supplies the bytes (#73). Resolves to true
 * when saved, false if the user cancelled.
 */
export async function createBackup(): Promise<boolean> {
  return invoke<boolean>('create_backup', {});
}

/** What the window learns about a restore: no paths or raw errors (#83). */
export interface RestoreOutcome {
  /** All agent tokens are revoked on restore; agents are kept and need new tokens. */
  tokensRevoked: number;
}

/**
 * Restore a backup. The backend opens the native open dialog itself (filtered to
 * 'swarmDraft backup' .zip files), validates the archive by its contents and restores it, so
 * the webview never supplies a path (#83). Resolves to null if the user cancelled. Rejects
 * with 'not-a-backup', 'too-new', 'busy', 'restore-failed' (book unchanged) or
 * 'restore-incomplete' (close the session); details go to the log.
 */
export async function restoreBackup(): Promise<RestoreOutcome | null> {
  return invoke<RestoreOutcome | null>('restore_backup', {});
}

/** Left by startup recovery when an interrupted restore's state could not be proven. */
export interface RecoveryNotice {
  /** Stable id; Dismiss removes only the notices with these ids. */
  id: string;
  /** Recovery folder, only when something was actually moved there. */
  folder: string | null;
  /** Items actually moved into `folder`. */
  moved: string[];
  snapshot: string | null;
  /** The attachments folder to copy files back into. */
  filesDir: string;
  reason: string;
  /** Recovery could not finish and will try again at the next start. */
  retryPending: boolean;
  /** Set when the notice could not be saved to disk. */
  saveError: string | null;
  /** An unreadable notice file was kept here (never deleted). */
  corruptFile: string | null;
}

/** Recovery notices waiting to be dismissed (empty in a plain browser). Reading does not clear. */
export async function getRecoveryNotices(): Promise<RecoveryNotice[]> {
  if (!isTauri()) return [];
  return invoke<RecoveryNotice[]>('recovery_notices');
}

/** Clear the shown recovery notices by id (the user pressed Dismiss); newer ones stay. */
export async function dismissRecoveryNotices(ids: string[]): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_recovery_notices', { ids });
}

/**
 * A notice from the rename migration (#43), separate from restore recovery.
 * Command `migration_notices` returns `MigrationNotice[]`; `dismiss_migration_notices({ ids })`
 * hides them for this launch. `text` is plain user-facing copy.
 */
export interface MigrationNotice {
  id: string;
  kind: 'info' | 'warn';
  text: string;
}

/** Migration notices for this launch (empty in a plain browser). */
export async function getMigrationNotices(): Promise<MigrationNotice[]> {
  if (!isTauri()) return [];
  return invoke<MigrationNotice[]>('migration_notices');
}

/** Hide the shown migration notices by id. */
export async function dismissMigrationNotices(ids: string[]): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_migration_notices', { ids });
}

export interface StoredManuscriptRow {
  id: string;
  title: string;
  createdAt: string;
  numberingStyle: string;
}

/** Progress while the backend imports or loads a manuscript (#80, ob6). */
export interface OpeningProgressEvent {
  stage: string;
  /** Whole-number percent, 0–100. */
  percent: number;
  title: string;
  chaptersFound: number;
}

export const OPENING_PROGRESS_EVENT = 'opening-progress';

/** Subscribe to backend opening progress; no-op in a plain browser. */
export async function listenOpeningProgress(
  onEvent: (event: OpeningProgressEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<OpeningProgressEvent>(OPENING_PROGRESS_EVENT, (e) => onEvent(e.payload));
}

/** A stored section plus its full Yjs state (v1 update from an empty doc). */
export interface StoredSection {
  id: string;
  manuscriptId: string;
  kind: string;
  parentId: string | null;
  position: number;
  title: string;
  docId: string;
  state: number[];
}

/** A manuscript as stored: its row and every section, in order, with document state. */
export interface StoredManuscript {
  manuscript: StoredManuscriptRow;
  sections: StoredSection[];
  /** The last stored update included; `pollUpdates` returns the ones written after it. */
  updatesCursor?: number;
}

/** Section updates written after a cursor (e.g. an agent's suggestions over MCP). */
export interface UpdatesSince {
  cursor: number;
  updates: { docId: string; update: number[] }[];
}

/**
 * Updates to a stored manuscript's sections written after `after`, oldest first (one page; poll
 * again with the returned cursor). Null in a plain browser.
 */
export async function pollUpdates(
  manuscriptId: string,
  after: number,
): Promise<UpdatesSince | null> {
  if (!isTauri()) return null;
  return invoke<UpdatesSince>('manuscript_updates_since', { manuscriptId, after });
}

/** The import payload the backend persists: one entry per section, in outline order. */
export interface ImportPayload {
  title: string;
  sections: { id: string; parentId?: string; kind: string; title: string; doc: unknown }[];
}

/**
 * Persist an imported manuscript (manuscript row, sections and their initial documents) in one
 * backend transaction, so agents can see it over MCP and it survives a restart. Returns the
 * stored manuscript (DB ids and doc state) to open, or null in a plain browser (no database).
 */
export async function persistImport(payload: ImportPayload): Promise<StoredManuscript | null> {
  if (!isTauri()) return null;
  return invoke<StoredManuscript>('manuscript_import_json', {
    title: payload.title,
    sections: payload.sections,
  });
}

/** The most recent manuscript, to reopen at startup; null if none or in a plain browser. */
export async function openLatestManuscript(): Promise<StoredManuscript | null> {
  if (!isTauri()) return null;
  return invoke<StoredManuscript | null>('manuscript_open_latest');
}

/** All stored manuscripts, newest first; empty in a plain browser. */
export async function listManuscripts(): Promise<StoredManuscriptRow[]> {
  if (!isTauri()) return [];
  return invoke<StoredManuscriptRow[]>('manuscripts_list');
}

/** Load one stored manuscript by id; null in a plain browser. */
export async function loadManuscript(manuscriptId: string): Promise<StoredManuscript | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<StoredManuscript>('manuscript_load', { manuscriptId });
  } catch {
    return null;
  }
}

/** Save an editor's Yjs update to a stored section (validated by the backend). */
export async function saveSectionUpdate(
  manuscriptId: string,
  sectionId: string,
  update: Uint8Array,
): Promise<void> {
  await invoke('section_apply_update', { manuscriptId, sectionId, update: Array.from(update) });
}

/**
 * Save a stored manuscript's whole outline (rename, reorder, move, add, delete) in one backend
 * transaction. Rejects, writing nothing, if the outline is invalid. No-op in a plain browser.
 */
export async function setManuscriptNumberingStyle(
  manuscriptId: string,
  style: string,
): Promise<StoredManuscriptRow> {
  return invoke<StoredManuscriptRow>('manuscript_set_numbering_style', { manuscriptId, style });
}

export async function saveOutline(
  manuscriptId: string,
  outline: { id: string; parentId?: string; kind: string; title: string; docId: string }[],
): Promise<void> {
  if (!isTauri()) return;
  await invoke('manuscript_save_outline', {
    manuscriptId,
    outline: outline.map((s) => ({
      id: s.id,
      parentId: s.parentId ?? null,
      kind: s.kind,
      title: s.title,
      docId: s.docId,
    })),
  });
}

/**
 * "Save a copy": send only the .docx bytes (and the title for the default file name). The
 * backend opens the native save dialog itself, so the webview never chooses the path, then
 * writes a temp file beside it and renames it into place, refusing the app's data folders.
 * Returns the path written, or null if the user cancelled.
 */
export async function saveManuscriptCopy(title: string, bytes: Uint8Array): Promise<string | null> {
  return invoke<string | null>('save_manuscript_copy', { title, bytes: Array.from(bytes) });
}

/** Open comments and saved agent names for the active section's review sidebar (#47). */
export interface SectionReviewMeta {
  comments: import('@coauthor/editor').CommentRow[];
  authorSavedNames: Record<string, string>;
}

export async function sectionReviewMeta(sectionId: string): Promise<SectionReviewMeta> {
  if (!isTauri()) return { comments: [], authorSavedNames: {} };
  return invoke<SectionReviewMeta>('section_review_meta', { sectionId });
}

/** Open comment rows for Save a copy .docx export (#74). */
export interface ManuscriptCopyComment {
  sectionId: string;
  threadId: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export async function manuscriptOpenComments(
  manuscriptId: string,
): Promise<ManuscriptCopyComment[]> {
  if (!isTauri()) return [];
  return invoke<ManuscriptCopyComment[]>('manuscript_open_comments', { manuscriptId });
}
