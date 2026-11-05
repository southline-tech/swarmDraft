import { describe, expect, it } from 'vitest';
import {
  availableBody,
  availableTitle,
  initialUpdatePromptState,
  manualMessageCopy,
  onCheckFailed,
  onDismissManualMessage,
  onDownloadProgress,
  onInstallFailed,
  onLater,
  onNoUpdate,
  onStartDownload,
  onUpdateAvailable,
  updatePromptEscapeAction,
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

  it('install failure uses distinct copy', () => {
    const next = onInstallFailed(onStartDownload(initialUpdatePromptState()));
    expect(next.manualMessage).toBe('install-failed');
    expect(manualMessageCopy('install-failed')).toBe(
      "Couldn't install the update. Your work is saved — try again later.",
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

  it('available copy matches Designer spec', () => {
    expect(availableTitle('1.2.3')).toBe('swarmDraft 1.2.3 is ready to install.');
    expect(availableBody()).toBe('swarmDraft will restart. Your work is saved first.');
  });

  it('Escape maps to Later or dismiss on result toasts', () => {
    expect(updatePromptEscapeAction('available')).toBe('later');
    expect(updatePromptEscapeAction('manual-message')).toBe('dismiss');
    expect(updatePromptEscapeAction('downloading')).toBeNull();
    expect(updatePromptEscapeAction('hidden')).toBeNull();
  });
});
