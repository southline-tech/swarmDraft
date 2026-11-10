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

describe('draft backbone commands (#116)', () => {
  it('returns null when not in Tauri', async () => {
    const { draftResolveChange, draftReviewCommit, draftBeginSession } = await import('./backend');
    await expect(draftResolveChange('m', 'c')).resolves.toBeNull();
    await expect(
      draftReviewCommit({
        manuscriptId: 'm',
        accepted: true,
        botName: 'Bot',
        chapterTitle: 'One',
        suggestionId: 'chg-1',
        kind: 'suggestion_insert',
        sectionId: 'sec',
      }),
    ).resolves.toBeNull();
    await expect(draftBeginSession('m')).resolves.toBeNull();
  });

  it('invokes draft_resolve_change and draft_review_commit when in Tauri', async () => {
    vi.resetModules();
    const invoke = vi.fn(async (cmd: string) =>
      cmd === 'draft_resolve_change' ? { result: 'notFound', changeId: 'missing' } : null,
    );
    vi.doMock('@tauri-apps/api/core', () => ({
      isTauri: () => true,
      invoke,
    }));
    const { draftResolveChange, draftReviewCommit } = await import('./backend');
    await draftResolveChange('m1', 'chg-1');
    await draftReviewCommit({
      manuscriptId: 'm1',
      accepted: false,
      botName: 'Bot',
      chapterTitle: 'One',
      suggestionId: 'chg-1',
      kind: 'suggestion_delete',
      sectionId: 'sec-1',
    });
    expect(invoke).toHaveBeenCalledWith('draft_resolve_change', {
      manuscriptId: 'm1',
      changeId: 'chg-1',
    });
    expect(invoke).toHaveBeenCalledWith('draft_review_commit', {
      manuscriptId: 'm1',
      accepted: false,
      botName: 'Bot',
      chapterTitle: 'One',
      suggestionId: 'chg-1',
      kind: 'suggestion_delete',
      sectionId: 'sec-1',
    });
    vi.doUnmock('@tauri-apps/api/core');
    vi.resetModules();
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
