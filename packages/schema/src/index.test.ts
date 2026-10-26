import { describe, expect, it } from 'vitest';
import { DEFAULT_TRIM, TRIM_SIZES, isSectionKind } from './index';

describe('schema', () => {
  it('defaults to 6x9 trim', () => {
    expect(DEFAULT_TRIM).toBe('6x9');
    expect(TRIM_SIZES[DEFAULT_TRIM]).toEqual({ widthIn: 6, heightIn: 9 });
  });

  it('recognises section kinds', () => {
    expect(isSectionKind('scene')).toBe(true);
    expect(isSectionKind('appendix')).toBe(false);
  });
});

describe('doc ids', () => {
  it('addresses each section separately', async () => {
    const { manuscriptDocId, sectionDocId } = await import('./index');
    expect(manuscriptDocId('m1')).toBe('manuscript/m1');
    expect(sectionDocId('m1', 'c2')).toBe('manuscript/m1/section/c2');
  });
});
