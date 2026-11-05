import { beforeEach, describe, expect, it } from 'vitest';
import { clampScrollTop, loadReadingPosition, saveReadingPosition } from './reading-position';

beforeEach(() => {
  localStorage.clear();
});

describe('reading position (#333)', () => {
  it('saves and loads per manuscript', () => {
    saveReadingPosition('m1', { sectionId: 'ch-2', scrollTop: 480 });
    expect(loadReadingPosition('m1')).toEqual({ sectionId: 'ch-2', scrollTop: 480 });
    expect(loadReadingPosition('other')).toBeNull();
  });

  it('clamps scroll when content is shorter than the saved offset', () => {
    expect(clampScrollTop(900, 200)).toBe(200);
    expect(clampScrollTop(-5, 200)).toBe(0);
  });
});
