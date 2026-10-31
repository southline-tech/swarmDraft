import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvidenceQuery } from './evidence-routes';

describe('evidence-routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null outside dev builds', () => {
    vi.stubEnv('DEV', false);
    expect(readEvidenceQuery('?evidence=rad55')).toBeNull();
  });

  it('reads the query in dev builds', () => {
    vi.stubEnv('DEV', true);
    expect(readEvidenceQuery('?evidence=rad67&frame=wp1')).toBe('rad67');
  });
});
