import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRad36Evidence, readRad36Frame } from './rad36-evidence';

describe('rad36-evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads frames for the #36 harness', () => {
    vi.stubEnv('DEV', true);
    expect(isRad36Evidence('?evidence=36-wp')).toBe(true);
    expect(readRad36Frame('?evidence=36-wp&frame=shortcuts')).toBe('shortcuts');
    expect(readRad36Frame('?evidence=36-wp')).toBe('find');
  });
});
