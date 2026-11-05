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

describe('draftTakeLaunchPath (#302)', () => {
  it('returns null when not in Tauri', async () => {
    const { draftTakeLaunchPath } = await import('./backend');
    await expect(draftTakeLaunchPath()).resolves.toBeNull();
  });

  it('invokes draft_take_launch_path when in Tauri', async () => {
    vi.resetModules();
    const invoke = vi.fn(async () => '/tmp/cold.draft');
    vi.doMock('@tauri-apps/api/core', () => ({
      isTauri: () => true,
      invoke,
    }));
    const { draftTakeLaunchPath } = await import('./backend');
    await expect(draftTakeLaunchPath()).resolves.toBe('/tmp/cold.draft');
    expect(invoke).toHaveBeenCalledWith('draft_take_launch_path');
    vi.doUnmock('@tauri-apps/api/core');
    vi.resetModules();
  });
});
