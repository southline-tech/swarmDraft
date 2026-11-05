import { afterEach, describe, expect, it, vi } from 'vitest';
import { devImportEvidenceDelay } from './dev-import-delay';

describe('devImportEvidenceDelay (#311)', () => {
  afterEach(() => {
    localStorage.removeItem('swarmdraft.slowImportMs');
    vi.unstubAllEnvs();
  });

  it('waits when DEV and localStorage ms is set', async () => {
    vi.stubEnv('MODE', 'development');
    localStorage.setItem('swarmdraft.slowImportMs', '40');
    const t0 = performance.now();
    await devImportEvidenceDelay();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it('skips when localStorage ms is unset', async () => {
    vi.stubEnv('MODE', 'development');
    const t0 = performance.now();
    await devImportEvidenceDelay();
    expect(performance.now() - t0).toBeLessThan(20);
  });
});
