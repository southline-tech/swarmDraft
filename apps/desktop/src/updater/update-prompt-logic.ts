/** Pure update-prompt state (#310). Updater I/O stays injectable for tests. */

import type { ManualCheckMessage } from '../copy-deck';

export {
  availableBody,
  availableTitle,
  manualMessageCopy,
  type ManualCheckMessage,
} from '../copy-deck';

export const AUTO_CHECK_DELAY_MS = 5000;

export type UpdatePromptMode = 'hidden' | 'available' | 'downloading' | 'manual-message';

export interface UpdatePromptState {
  mode: UpdatePromptMode;
  version: string | null;
  progress: number | null;
  manualMessage: ManualCheckMessage | null;
  dismissedForSession: boolean;
}

export function initialUpdatePromptState(): UpdatePromptState {
  return {
    mode: 'hidden',
    version: null,
    progress: null,
    manualMessage: null,
    dismissedForSession: false,
  };
}

export function onUpdateAvailable(
  state: UpdatePromptState,
  version: string,
  manual: boolean,
): UpdatePromptState {
  if (state.dismissedForSession && !manual) {
    return { ...state, manualMessage: null };
  }
  return {
    ...state,
    mode: 'available',
    version,
    progress: null,
    manualMessage: null,
  };
}

export function onNoUpdate(state: UpdatePromptState, manual: boolean): UpdatePromptState {
  if (!manual) {
    return { ...state, manualMessage: null };
  }
  return {
    ...state,
    mode: 'manual-message',
    version: null,
    progress: null,
    manualMessage: 'up-to-date',
  };
}

export function onCheckFailed(
  state: UpdatePromptState,
  manual: boolean,
  kind: 'offline' | 'error',
): UpdatePromptState {
  if (!manual) {
    return { ...state, manualMessage: null };
  }
  return {
    ...state,
    mode: 'manual-message',
    version: null,
    progress: null,
    manualMessage: kind,
  };
}

export function onInstallFailed(state: UpdatePromptState): UpdatePromptState {
  return {
    ...state,
    mode: 'manual-message',
    version: null,
    progress: null,
    manualMessage: 'install-failed',
  };
}

export function onLater(state: UpdatePromptState): UpdatePromptState {
  return {
    ...state,
    mode: 'hidden',
    version: null,
    progress: null,
    manualMessage: null,
    dismissedForSession: true,
  };
}

export function onDismissManualMessage(state: UpdatePromptState): UpdatePromptState {
  return {
    ...state,
    mode: 'hidden',
    manualMessage: null,
  };
}

export function onStartDownload(state: UpdatePromptState): UpdatePromptState {
  return {
    ...state,
    mode: 'downloading',
    progress: 0,
    manualMessage: null,
  };
}

export function onDownloadProgress(state: UpdatePromptState, progress: number): UpdatePromptState {
  return {
    ...state,
    mode: 'downloading',
    progress: Math.max(0, Math.min(100, progress)),
  };
}

/** Esc on the update toast: Later when an update is offered, Got it on result toasts. */
export function updatePromptEscapeAction(mode: UpdatePromptMode): 'later' | 'dismiss' | null {
  if (mode === 'available') return 'later';
  if (mode === 'manual-message') return 'dismiss';
  return null;
}
