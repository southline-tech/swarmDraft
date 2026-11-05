import { isTauri } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import {
  AUTO_CHECK_DELAY_MS,
  initialUpdatePromptState,
  onCheckFailed,
  onDismissManualMessage,
  onDownloadProgress,
  onLater,
  onNoUpdate,
  onStartDownload,
  onUpdateAvailable,
  type UpdatePromptState,
} from './update-prompt-logic';

export { AUTO_CHECK_DELAY_MS, initialUpdatePromptState, type UpdatePromptState };

export type UpdaterCheck = () => Promise<Update | null>;

export interface UpdaterDeps {
  checkForUpdate: UpdaterCheck;
  downloadAndInstall: (update: Update, onEvent: (progress: number) => void) => Promise<void>;
  relaunchApp: () => Promise<void>;
  isDesktop: () => boolean;
}

export function classifyUpdaterError(err: unknown): 'offline' | 'error' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch|network|offline|dns|connect|timed out|connection/i.test(msg)) return 'offline';
  return 'error';
}

export function defaultUpdaterDeps(): UpdaterDeps {
  return {
    isDesktop: () => isTauri(),
    checkForUpdate: () => check(),
    downloadAndInstall: async (update, onProgress) => {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            onProgress(0);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) {
              onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
            }
            break;
          case 'Finished':
            onProgress(100);
            break;
        }
      });
    },
    relaunchApp: () => relaunch(),
  };
}

export interface AppUpdaterHandle {
  state: () => UpdatePromptState;
  scheduleAutoCheck: () => void;
  manualCheck: () => Promise<void>;
  later: () => void;
  dismissManual: () => void;
  installPending: (flushDraft: () => Promise<void>) => Promise<void>;
  dispose: () => void;
}

export function createAppUpdater(
  deps: UpdaterDeps,
  onChange: (state: UpdatePromptState) => void,
): AppUpdaterHandle {
  let state = initialUpdatePromptState();
  let pending: Update | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let installing = false;

  const emit = () => onChange(state);

  const runCheck = async (manual: boolean) => {
    if (!deps.isDesktop() || checking || installing) return;
    checking = true;
    try {
      const update = await deps.checkForUpdate();
      if (update) {
        pending = update;
        state = onUpdateAvailable(state, update.version, manual);
      } else {
        pending = null;
        state = onNoUpdate(state, manual);
      }
    } catch (err) {
      pending = null;
      state = onCheckFailed(state, manual, classifyUpdaterError(err));
    } finally {
      checking = false;
      emit();
    }
  };

  return {
    state: () => state,
    scheduleAutoCheck: () => {
      if (!deps.isDesktop()) return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => void runCheck(false), AUTO_CHECK_DELAY_MS);
    },
    manualCheck: () => runCheck(true),
    later: () => {
      state = onLater(state);
      emit();
    },
    dismissManual: () => {
      state = onDismissManualMessage(state);
      emit();
    },
    installPending: async (flushDraft) => {
      if (!pending || installing) return;
      installing = true;
      state = onStartDownload(state);
      emit();
      try {
        await flushDraft();
        await deps.downloadAndInstall(pending, (progress) => {
          state = onDownloadProgress(state, progress);
          emit();
        });
        await deps.relaunchApp();
      } catch (err) {
        installing = false;
        pending = null;
        state = onCheckFailed(state, true, classifyUpdaterError(err));
        emit();
      }
    },
    dispose: () => clearTimeout(autoTimer),
  };
}
