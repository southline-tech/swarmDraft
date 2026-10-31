import { describe, expect, it } from 'vitest';
import { formatSavedAt, saveStatusLabel } from './save-status';

describe('formatSavedAt', () => {
  const t0 = 1_700_000_000_000;

  it('uses just-now within a minute', () => {
    expect(formatSavedAt(t0, t0 + 5_000)).toBe('Saved just now');
    expect(formatSavedAt(t0, t0 + 59_000)).toBe('Saved just now');
  });

  it('uses minutes after that', () => {
    expect(formatSavedAt(t0, t0 + 60_000)).toBe('Saved 1 min ago');
    expect(formatSavedAt(t0, t0 + 120_000)).toBe('Saved 2 min ago');
  });
});

describe('saveStatusLabel', () => {
  it('maps phases to copy', () => {
    expect(saveStatusLabel({ phase: 'idle' })).toBe('');
    expect(saveStatusLabel({ phase: 'saving' })).toBe('Saving…');
    expect(saveStatusLabel({ phase: 'error', message: 'Not saved' })).toBe('Not saved');
    expect(saveStatusLabel({ phase: 'saved', savedAt: 0 }, 30_000)).toBe('Saved just now');
  });
});
