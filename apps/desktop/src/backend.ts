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
