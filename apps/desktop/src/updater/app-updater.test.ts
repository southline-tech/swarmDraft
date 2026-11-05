import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppUpdater, type UpdaterDeps } from './app-updater';

function mockUpdate(version: string) {
  return { version } as unknown as import('@tauri-apps/plugin-updater').Update;
}

function deps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    isDesktop: () => true,
    checkForUpdate: vi.fn(async () => null),
    downloadAndInstall: vi.fn(async (_u, onProgress) => onProgress(100)),
    relaunchApp: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createAppUpdater (#310)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto check stays silent when offline', async () => {
    const d = deps({
      checkForUpdate: vi.fn(async () => {
        throw new Error('network error');
      }),
    });
    let latest = createAppUpdater(d, () => {}).state();
    const handle = createAppUpdater(d, (s) => {
      latest = s;
    });
    handle.scheduleAutoCheck();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();
    expect(latest.mode).toBe('hidden');
  });

  it('manual check reports offline', async () => {
    const d = deps({
      checkForUpdate: vi.fn(async () => {
        throw new Error('Failed to fetch');
      }),
    });
    let latest = createAppUpdater(d, () => {}).state();
    const handle = createAppUpdater(d, (s) => {
      latest = s;
    });
    await handle.manualCheck();
    expect(latest.manualMessage).toBe('offline');
  });

  it('flush failure restores available prompt without install-failed copy', async () => {
    const update = mockUpdate('9.9.9');
    const d = deps({
      checkForUpdate: vi.fn(async () => update),
    });
    let latest = createAppUpdater(d, () => {}).state();
    const handle = createAppUpdater(d, (s) => {
      latest = s;
    });
    await handle.manualCheck();
    await handle.installPending(
      vi.fn(async () => {
        throw new Error('save failed');
      }),
    );
    expect(latest.mode).toBe('available');
    expect(latest.manualMessage).toBeNull();
    expect(d.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('install failure shows install-failed message', async () => {
    const update = mockUpdate('9.9.9');
    const d = deps({
      checkForUpdate: vi.fn(async () => update),
      downloadAndInstall: vi.fn(async () => {
        throw new Error('signature invalid');
      }),
    });
    let latest = createAppUpdater(d, () => {}).state();
    const handle = createAppUpdater(d, (s) => {
      latest = s;
    });
    await handle.manualCheck();
    await handle.installPending(vi.fn(async () => {}));
    expect(latest.manualMessage).toBe('install-failed');
  });

  it('install flushes then relaunches', async () => {
    const update = mockUpdate('9.9.9');
    const d = deps({
      checkForUpdate: vi.fn(async () => update),
      downloadAndInstall: vi.fn(async (_u, onProgress) => onProgress(50)),
    });
    let latest = createAppUpdater(d, () => {}).state();
    const handle = createAppUpdater(d, (s) => {
      latest = s;
    });
    await handle.manualCheck();
    const flush = vi.fn(async () => {});
    await handle.installPending(flush);
    expect(flush).toHaveBeenCalled();
    expect(d.relaunchApp).toHaveBeenCalled();
    expect(latest.progress).toBe(50);
  });
});
