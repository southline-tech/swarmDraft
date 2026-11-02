import { invoke, isTauri } from '@tauri-apps/api/core';

/** Dev-only toolbar handoff logs; in Tauri dev they also appear on stderr (pnpm dev terminal). */
export function devToolbarLog(event: string, detail?: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.debug('[toolbar-host]', event, detail ?? {});
  if (isTauri()) {
    const line = `[toolbar-host] ${event} ${JSON.stringify(detail ?? {})}`;
    void invoke('dev_front_log', { line }).catch(() => {});
  }
}
