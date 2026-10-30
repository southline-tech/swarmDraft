import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWebSectionReviewMeta, sectionReviewMeta, setWebSectionReviewMeta } from './backend';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

describe('sectionReviewMeta browser path (#60)', () => {
  afterEach(() => {
    clearWebSectionReviewMeta();
  });

  it('returns seeded suggestionReasons when not in Tauri', async () => {
    setWebSectionReviewMeta('sec-a', {
      comments: [],
      authorSavedNames: { 'agent:a': 'Bot' },
      suggestionReasons: { s1: 'Stronger verb.' },
    });
    await expect(sectionReviewMeta('sec-a')).resolves.toMatchObject({
      suggestionReasons: { s1: 'Stronger verb.' },
    });
    await expect(sectionReviewMeta('missing')).resolves.toMatchObject({
      suggestionReasons: {},
    });
  });
});
