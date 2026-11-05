import { describe, expect, it } from 'vitest';
import {
  availableMessage,
  initialUpdatePromptState,
  manualMessageCopy,
  onCheckFailed,
  onDismissManualMessage,
  onDownloadProgress,
  onLater,
  onNoUpdate,
  onStartDownload,
  onUpdateAvailable,
} from './update-prompt-logic';

describe('update prompt logic (#310)', () => {
  it('shows available toast on auto check when not dismissed', () => {
    const next = onUpdateAvailable(initialUpdatePromptState(), '0.2.0', false);
    expect(next.mode).toBe('available');
    expect(next.version).toBe('0.2.0');
  });

  it('hides auto available prompt after Later until next launch', () => {
    let state = onUpdateAvailable(initialUpdatePromptState(), '0.2.0', false);
    state = onLater(state);
    state = onUpdateAvailable(state, '0.2.0', false);
    expect(state.mode).toBe('hidden');
  });

  it('manual check still shows available after Later', () => {
    let state = onLater(onUpdateAvailable(initialUpdatePromptState(), '0.2.0', false));
    state = onUpdateAvailable(state, '0.2.0', true);
    expect(state.mode).toBe('available');
  });

  it('same version manual check shows up to date only', () => {
    const next = onNoUpdate(initialUpdatePromptState(), true);
    expect(next.manualMessage).toBe('up-to-date');
    expect(manualMessageCopy('up-to-date')).toBe("You're up to date.");
  });

  it('auto same version stays silent', () => {
    expect(onNoUpdate(initialUpdatePromptState(), false).mode).toBe('hidden');
  });

  it('offline and error only surface on manual check', () => {
    expect(onCheckFailed(initialUpdatePromptState(), false, 'offline').mode).toBe('hidden');
    expect(onCheckFailed(initialUpdatePromptState(), true, 'offline').manualMessage).toBe(
      'offline',
    );
  });

  it('download progress updates the bar', () => {
    let state = onStartDownload(onUpdateAvailable(initialUpdatePromptState(), '0.2.0', true));
    state = onDownloadProgress(state, 42);
    expect(state.progress).toBe(42);
  });

  it('dismiss clears manual message', () => {
    expect(onDismissManualMessage(onNoUpdate(initialUpdatePromptState(), true)).mode).toBe(
      'hidden',
    );
  });

  it('available copy includes version', () => {
    expect(availableMessage('1.2.3')).toBe('swarmDraft 1.2.3 is available');
  });
});
