import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OldChangeView from './OldChangeView.vue';
import { UNKNOWN_CHANGE_TOAST, openChangeLink, type ChangeLinkRoute } from './open-link';
import type { OldChangeViewModel } from './open-link';

function localWhen(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const historyView = (over: Partial<OldChangeViewModel> = {}): OldChangeViewModel => ({
  manuscriptId: 'book-1',
  changeId: 'chg-1',
  sectionId: 'sec-1',
  quote: 'guttered',
  kind: 'suggestion_insert',
  authorName: 'Ada',
  outcome: 'accepted',
  decidedBy: 'Sam',
  decidedAt: 1700000000,
  ...over,
});

function route(): ChangeLinkRoute & {
  focus: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  opened: ReturnType<typeof vi.fn>;
} {
  const focus = vi.fn(async () => {});
  const history = vi.fn();
  const toast = vi.fn();
  const failed = vi.fn();
  const opened = vi.fn(async () => true);
  return {
    focus,
    history,
    toast,
    failed,
    opened,
    ensureManuscript: opened,
    focusChange: focus,
    showHistory: history,
    showToast: toast,
    clearOpenError: vi.fn(),
    onFailure: failed,
  };
}

const url = 'swarmdraft://open?draft=book-1&change=chg-1';

describe('open change link (#117, #123)', () => {
  it('focuses a live change', async () => {
    const r = route();
    await openChangeLink(url, r, async () => ({
      action: 'focus',
      manuscriptId: 'book-1',
      sectionId: 'sec-1',
      changeId: 'chg-1',
    }));
    expect(r.opened).toHaveBeenCalledWith('book-1');
    expect(r.focus).toHaveBeenCalledWith('sec-1', 'chg-1');
    expect(r.history).not.toHaveBeenCalled();
    expect(r.toast).not.toHaveBeenCalled();
    expect(r.failed).not.toHaveBeenCalled();
  });

  it('opens a moved change at its new section', async () => {
    const r = route();
    await openChangeLink(url, r, async () => ({
      action: 'focus',
      manuscriptId: 'book-1',
      sectionId: 'sec-new',
      changeId: 'chg-1',
    }));
    expect(r.focus).toHaveBeenCalledWith('sec-new', 'chg-1');
    expect(r.history).not.toHaveBeenCalled();
    expect(r.failed).not.toHaveBeenCalled();
  });

  it('shows the old-change view for an accepted change', async () => {
    const accepted = {
      action: 'history' as const,
      manuscriptId: 'book-1',
      changeId: 'chg-1',
      sectionId: 'sec-1',
      quote: 'guttered',
      kind: 'suggestion_insert',
      authorName: 'Ada',
      outcome: 'accepted',
      decidedBy: 'Sam',
      decidedAt: 1700000000,
    };
    const r = route();
    await openChangeLink(url, r, async () => accepted);
    expect(r.focus).not.toHaveBeenCalled();
    expect(r.history).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        decidedBy: 'Sam',
        quote: 'guttered',
        kind: 'suggestion_insert',
      }),
    );
    expect(r.failed).not.toHaveBeenCalled();
    const w = mount(OldChangeView, {
      props: { view: r.history.mock.calls[0]![0] },
      attachTo: document.body,
    });
    await flushPromises();
    const view = document.querySelector('[data-test="old-change-view"]')!;
    expect(view.getAttribute('aria-describedby')).toBe('old-change-summary');
    expect(view.textContent).toContain('This change was accepted');
    expect(view.textContent).toContain('Sam accepted');
    expect(view.textContent).toContain("Ada's change");
    expect(view.textContent).toContain(localWhen(1700000000));
    expect(view.textContent).not.toContain('UTC');
    expect(view.textContent).toContain('Added text');
    expect(view.textContent).not.toContain('suggestion_insert');
    expect(view.textContent).toContain('Original wording');
    expect(view.textContent).toContain('guttered');
    expect(view.querySelector('[data-test="old-change-quote"]')?.className).toContain(
      'old-change__quote--insert',
    );
    expect(view.textContent).toContain('Back to my book');
    expect(view.querySelector('[data-test="old-change-chapter"]')).toBeNull();
    expect(view.querySelector('textarea, [contenteditable="true"]')).toBeNull();
    w.unmount();
  });

  it('shows the old-change view for a rejected change', async () => {
    const rejected = {
      action: 'history' as const,
      manuscriptId: 'book-1',
      changeId: 'chg-1',
      sectionId: 'sec-1',
      quote: 'flickered',
      kind: 'suggestion_delete',
      authorName: 'Ada',
      outcome: 'rejected',
      decidedBy: 'Riley',
      decidedAt: 1700000000,
    };
    const r = route();
    await openChangeLink(url, r, async () => rejected);
    const w = mount(OldChangeView, {
      props: { view: r.history.mock.calls[0]![0] },
      attachTo: document.body,
    });
    await flushPromises();
    const view = document.querySelector('[data-test="old-change-view"]')!;
    expect(view.textContent).toContain('This change was rejected');
    expect(view.textContent).toContain('Riley rejected');
    expect(view.textContent).toContain("Ada's change");
    expect(view.textContent).toContain('Removed text');
    expect(view.textContent).not.toContain('suggestion_delete');
    expect(view.querySelector('[data-test="old-change-quote"]')?.className).toContain(
      'old-change__quote--delete',
    );
    expect(view.textContent).toContain('flickered');
    expect(r.failed).not.toHaveBeenCalled();
    w.unmount();
  });

  it('shows an edited-later change without the stored kind, and an empty quote', async () => {
    const w = mount(OldChangeView, {
      props: {
        view: historyView({
          outcome: 'recorded',
          kind: 'suggestion_replace',
          quote: '',
          decidedBy: '',
        }),
      },
      attachTo: document.body,
    });
    await flushPromises();
    const view = document.querySelector('[data-test="old-change-view"]')!;
    expect(view.textContent).toContain('This change was edited later');
    expect(view.textContent).toContain(
      "Ada suggested this change. It was changed again later, so it's no longer in your book.",
    );
    expect(view.textContent).toContain('Change');
    expect(view.textContent).not.toContain('suggestion_replace');
    expect(view.textContent).toContain("The original wording wasn't saved with this change.");
    w.unmount();
  });

  it('Back to my book closes and focuses the editor, including when the opener is the body', async () => {
    const focusEditor = vi.fn();
    const w = mount(OldChangeView, {
      props: { view: historyView(), chapterNumber: 3, focusEditor },
      attachTo: document.body,
    });
    await flushPromises();
    const chapter = document.querySelector<HTMLButtonElement>('[data-test="old-change-chapter"]')!;
    expect(chapter.textContent).toContain('Go to Chapter 3');
    chapter.click();
    expect(w.emitted('go-chapter')).toHaveLength(1);
    w.unmount();
    expect(focusEditor).not.toHaveBeenCalled();

    const again = mount(OldChangeView, {
      props: { view: historyView(), focusEditor },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('old-change-back');
    document.querySelector<HTMLButtonElement>('[data-test="old-change-back"]')!.click();
    expect(again.emitted('close')).toHaveLength(1);
    again.unmount();
    expect(focusEditor).toHaveBeenCalledTimes(1);
  });

  it('toasts an unknown id and does not raise an open error', async () => {
    const r = route();
    const result = await openChangeLink(url, r, async () => ({
      action: 'unknown',
      manuscriptId: 'book-1',
    }));
    expect(result).toBe('opened');
    expect(r.opened).toHaveBeenCalledWith('book-1');
    expect(UNKNOWN_CHANGE_TOAST).toBe(
      "That change isn't in this book's history. Your book is open where you left off.",
    );
    expect(r.toast).toHaveBeenCalledWith(UNKNOWN_CHANGE_TOAST);
    expect(r.failed).not.toHaveBeenCalled();
    expect(r.focus).not.toHaveBeenCalled();
    expect(r.history).not.toHaveBeenCalled();
  });
});
