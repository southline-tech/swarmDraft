import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_IDLE_SYNC_MS,
  flushIdleDraftSync,
  resetIdleDraftSyncTimers,
  scheduleIdleDraftSync,
} from './draft-idle-sync';

afterEach(() => {
  vi.useRealTimers();
  resetIdleDraftSyncTimers();
});

describe('draft idle sync (#356)', () => {
  it('debounces checkpoint then pack', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn();
    const pack = vi.fn();
    scheduleIdleDraftSync(checkpoint, pack);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(pack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_SYNC_MS);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(pack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_SYNC_MS);
    expect(pack).toHaveBeenCalledTimes(1);
  });

  it('resetting the debounce does not pack on every section save tick', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn();
    const pack = vi.fn();
    for (let i = 0; i < 5; i++) scheduleIdleDraftSync(checkpoint, pack);
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_SYNC_MS * 2 + 10);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(pack).toHaveBeenCalledTimes(1);
  });

  it('flush runs checkpoint and pack immediately', () => {
    const checkpoint = vi.fn();
    const pack = vi.fn();
    scheduleIdleDraftSync(checkpoint, pack);
    flushIdleDraftSync(checkpoint, pack);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(pack).toHaveBeenCalledTimes(1);
  });
});
