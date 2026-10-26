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

export interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAtUnix: number;
  files: string[];
}

export interface RestoreReport {
  manifest: BackupManifest;
  preRestoreSnapshot: string;
}

/** Write a full-project backup .zip into the data dir's backups folder; returns its path. */
export async function createBackup(): Promise<string> {
  return invoke<string>('create_backup');
}

/** Validate and restore a backup .zip. The replaced state is saved as a pre-restore snapshot. */
export async function restoreBackup(path: string): Promise<RestoreReport> {
  return invoke<RestoreReport>('restore_backup', { path });
}
