import { invoke, isTauri } from '@tauri-apps/api/core';

export interface AppInfo {
  version: string;
  dataDir: string;
  schemaVersion: number;
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

export interface RestoreReport {
  /** All agent tokens are revoked on restore; agents are kept and need new tokens. */
  tokensRevoked: number;
  manifest: BackupManifest;
  preRestoreSnapshot: string;
}

/**
 * Write a full-project backup .zip to `dest` or, if omitted, into the data dir's backups
 * folder; returns its path. An existing `dest` is refused unless `replace` is true (the user
 * confirmed Replace in the save dialog), in which case it is atomically replaced: written to
 * a temp file beside it, then renamed over it.
 */
export async function createBackup(dest?: string, replace = false): Promise<string> {
  return invoke<string>('create_backup', { dest: dest ?? null, replace });
}

const ZIP_FILTER = [{ name: 'coAuthor backup', extensions: ['zip'] }];

/** Native open dialog for a backup .zip; null if cancelled. */
export async function pickBackupToRestore(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const p = await open({ multiple: false, directory: false, filters: ZIP_FILTER });
  return typeof p === 'string' ? p : null;
}

/** Native save-as dialog for a new backup; null if cancelled. */
export async function pickBackupDestination(): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return save({ defaultPath: `coauthor-backup-${stamp}.zip`, filters: ZIP_FILTER });
}

/** Validate and restore a backup .zip. The replaced state is saved as a pre-restore snapshot. */
export async function restoreBackup(path: string): Promise<RestoreReport> {
  return invoke<RestoreReport>('restore_backup', { path });
}

/** Left by startup recovery when an interrupted restore's state could not be proven. */
export interface RecoveryNotice {
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
}

/** Recovery notices waiting to be dismissed (empty in a plain browser). Reading does not clear. */
export async function getRecoveryNotices(): Promise<RecoveryNotice[]> {
  if (!isTauri()) return [];
  return invoke<RecoveryNotice[]>('recovery_notices');
}

/** Clear the recovery notices (the user pressed Dismiss). */
export async function dismissRecoveryNotices(): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_recovery_notices');
}
