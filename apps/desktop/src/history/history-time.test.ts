import { describe, expect, it } from 'vitest';
import { formatHistoryDayHeader, formatHistoryRowWhen } from './history-time';

describe('history time (#365)', () => {
  const now = new Date(2026, 10, 17, 15, 0, 0);

  it('shows Today with time only', () => {
    const sec = Math.floor(new Date(2026, 10, 17, 10, 22, 0).getTime() / 1000);
    expect(formatHistoryRowWhen(sec, now)).toMatch(/^Today /);
  });

  it('includes year when not this year', () => {
    const sec = Math.floor(new Date(2025, 9, 28, 17, 40, 0).getTime() / 1000);
    expect(formatHistoryRowWhen(sec, now)).toContain('2025');
  });

  it('groups by day headers', () => {
    const sec = Math.floor(new Date(2026, 10, 17, 9, 0, 0).getTime() / 1000);
    expect(formatHistoryDayHeader(sec, now)).toBe('Today');
    const y = Math.floor(new Date(2026, 10, 16, 9, 0, 0).getTime() / 1000);
    expect(formatHistoryDayHeader(y, now)).toBe('Yesterday');
  });

  it('never prints Invalid Date or NaN for a missing stamp', () => {
    expect(formatHistoryRowWhen(Number.NaN)).toBe('');
    expect(formatHistoryDayHeader(Number.NaN)).toBe('');
    expect(formatHistoryRowWhen(undefined as unknown as number)).not.toMatch(/Invalid Date|NaN/);
    expect(formatHistoryDayHeader(undefined as unknown as number)).not.toMatch(/Invalid Date|NaN/);
  });
});
