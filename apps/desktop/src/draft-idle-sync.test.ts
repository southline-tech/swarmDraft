import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_IDLE_CHECKPOINT_MS,
  flushIdleDraftCheckpoint,
  resetIdleDraftCheckpointTimers,
  scheduleIdleDraftCheckpoint,
} from './draft-idle-sync';

afterEach(() => {
  vi.useRealTimers();
  resetIdleDraftCheckpointTimers();
});

describe('draft idle checkpoint (#356)', () => {
  it('debounces git checkpoint without packing', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn();
    scheduleIdleDraftCheckpoint(checkpoint);
    expect(checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_CHECKPOINT_MS);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('resetting the debounce does not checkpoint on every section save tick', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn();
    for (let i = 0; i < 5; i++) scheduleIdleDraftCheckpoint(checkpoint);
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_CHECKPOINT_MS + 10);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('flush runs a pending checkpoint immediately', () => {
    const checkpoint = vi.fn();
    scheduleIdleDraftCheckpoint(checkpoint);
    flushIdleDraftCheckpoint(checkpoint);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
});
