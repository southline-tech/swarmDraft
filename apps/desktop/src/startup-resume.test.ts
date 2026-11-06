import { describe, expect, it } from 'vitest';
import { shouldShowImportHome, startupResumeAfterReopen } from './startup-resume';

describe('startup resume (#329)', () => {
  it('ends pending after reopen attempt finishes', () => {
    expect(startupResumeAfterReopen()).toBe('done');
  });

  it('hides import home while pending', () => {
    expect(shouldShowImportHome('pending', false, false, false)).toBe(false);
    expect(shouldShowImportHome('done', false, false, false)).toBe(true);
  });

  it('keeps editor visible when a session is open', () => {
    expect(shouldShowImportHome('done', true, false, false)).toBe(false);
  });
});
