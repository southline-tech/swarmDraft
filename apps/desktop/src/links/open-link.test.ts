import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { agentDirectory, setAgents } from '../agent-names';
import OldChangeView from './OldChangeView.vue';
import {
  UNKNOWN_CHANGE_TOAST,
  openChangeLink,
  openReviewLink,
  type ChangeLinkRoute,
} from './open-link';
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
  selected: ReturnType<typeof vi.fn>;
} {
  const focus = vi.fn(async () => {});
  const history = vi.fn();
  const toast = vi.fn();
  const failed = vi.fn();
  const opened = vi.fn(async () => true);
  const selected = vi.fn();
  return {
    focus,
    history,
    toast,
    failed,
    opened,
    selected,
    ensureManuscript: opened,
    focusChange: focus,
    showHistory: history,
    showToast: toast,
    resetLinkUi: vi.fn(),
    showSelectedChanges: selected,
    clearOpenError: vi.fn(),
    onFailure: failed,
  };
}

const url = 'swarmdraft://open?draft=book-1&change=chg-1';

afterEach(() => {
  agentDirectory.value = null;
});

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
    expect(view.querySelector('[data-test="agent-tag"]')).toBeNull();
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

  it('names the writer and the bot, and does not show a raw agent id', async () => {
    setAgents([
      {
        id: 'bot-1',
        name: 'Line Editor',
        color: '#3366ff',
        createdAt: '2026-10-26T00:00:00Z',
        revokedAt: null,
        primary: false,
      },
    ]);
    const w = mount(OldChangeView, {
      props: {
        view: historyView({
          authorName: 'agent:bot-1',
          authorKind: 'agent',
          decidedBy: 'Sam',
        }),
      },
      attachTo: document.body,
    });
    await flushPromises();
    const summary = document.querySelector('[data-test="old-change-summary"]')!;
    expect(summary.textContent).toContain('Sam accepted');
    expect(summary.textContent).toContain('Line Editor');
    expect(summary.textContent).not.toContain('agent:');
    const author = summary.querySelector('[data-test="old-change-author"]')!;
    expect(author.tagName).toBe('BDI');
    expect(author.getAttribute('dir')).toBe('auto');
    expect(author.textContent).toBe('Line Editor');
    expect(summary.querySelector('[data-test="agent-tag"]')?.textContent).toBe('Bot');
    const summaryText = summary.textContent ?? '';
    const possessive = summaryText.indexOf("Line Editor's change");
    const badge = summaryText.indexOf('Bot');
    const when = summaryText.indexOf(localWhen(1700000000));
    expect(possessive).toBeGreaterThan(-1);
    expect(badge).toBeGreaterThan(possessive);
    expect(when).toBeGreaterThan(badge);
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

describe('open review link (#119)', () => {
  const reviewUrl = 'swarmdraft://review?draft=book-1&changes=chg-1,missing,chg-2';

  it('filters to the open changes and toasts how many ids were unknown', async () => {
    const r = route();
    const result = await openReviewLink(reviewUrl, r, async (_manuscriptId, changeId) => {
      if (changeId === 'missing') return { action: 'unknown', manuscriptId: 'book-1' };
      return {
        action: 'focus',
        manuscriptId: 'book-1',
        sectionId: changeId === 'chg-2' ? 'sec-new' : 'sec-1',
        changeId,
      };
    });
    expect(result).toBe('opened');
    expect(r.opened).toHaveBeenCalledWith('book-1');
    expect(r.selected).toHaveBeenCalledWith(['chg-1', 'chg-2']);
    expect(r.toast).toHaveBeenCalledWith(
      "1 change isn't in this book's history. The others are in your review list.",
    );
    expect(r.history).not.toHaveBeenCalled();
    expect(r.focus).not.toHaveBeenCalled();
  });

  it('shows the old-change view for a decided change and keeps the other ids in the filter', async () => {
    const r = route();
    await openReviewLink(reviewUrl, r, async (_manuscriptId, changeId) => {
      if (changeId === 'chg-2') {
        return {
          action: 'history',
          manuscriptId: 'book-1',
          changeId,
          sectionId: 'sec-1',
          quote: 'guttered',
          kind: 'suggestion_insert',
          authorKind: 'agent',
          authorName: 'Line Editor',
          outcome: 'accepted',
          decidedBy: 'Sam',
          decidedAt: 1700000000,
        };
      }
      if (changeId === 'missing') return { action: 'unknown', manuscriptId: 'book-1' };
      return {
        action: 'focus',
        manuscriptId: 'book-1',
        sectionId: 'sec-1',
        changeId,
      };
    });
    expect(r.selected).toHaveBeenCalledWith(['chg-1']);
    expect(r.history).toHaveBeenCalledWith(
      expect.objectContaining({
        changeId: 'chg-2',
        outcome: 'accepted',
        authorName: 'Line Editor',
      }),
    );
    expect(r.toast).toHaveBeenCalledWith(
      "1 change isn't in this book's history. The others are in your review list.",
    );
  });

  it('says several missing changes left the others in the review list', async () => {
    const r = route();
    const url = 'swarmdraft://review?draft=book-1&changes=chg-1,missing-a,missing-b';
    await openReviewLink(url, r, async (_manuscriptId, changeId) => {
      if (changeId !== 'chg-1') return { action: 'unknown', manuscriptId: 'book-1' };
      return {
        action: 'focus',
        manuscriptId: 'book-1',
        sectionId: 'sec-1',
        changeId,
      };
    });
    expect(r.selected).toHaveBeenCalledWith(['chg-1']);
    expect(r.toast).toHaveBeenCalledWith(
      "2 changes aren't in this book's history. The others are in your review list.",
    );
  });

  it('says the book stayed put when the only linked change is missing', async () => {
    const r = route();
    const url = 'swarmdraft://review?draft=book-1&changes=missing';
    const result = await openReviewLink(url, r, async () => ({
      action: 'unknown',
      manuscriptId: 'book-1',
    }));
    expect(result).toBe('opened');
    expect(r.selected).not.toHaveBeenCalled();
    expect(r.history).not.toHaveBeenCalled();
    expect(r.toast).toHaveBeenCalledWith(
      "That change isn't in this book's history. Your book is open where you left off.",
    );
    expect(r.failed).not.toHaveBeenCalled();
  });

  it('says the book stayed put when every linked change is missing', async () => {
    const r = route();
    const url = 'swarmdraft://review?draft=book-1&changes=missing-a,missing-b';
    await openReviewLink(url, r, async () => ({
      action: 'unknown',
      manuscriptId: 'book-1',
    }));
    expect(r.selected).not.toHaveBeenCalled();
    expect(r.history).not.toHaveBeenCalled();
    expect(r.toast).toHaveBeenCalledWith(
      "None of those changes are in this book's history. Your book is open where you left off.",
    );
  });

  it('gives every decided id a history view, not only the first', async () => {
    const r = route();
    const url = 'swarmdraft://review?draft=book-1&changes=open-1,acc-1,acc-2';
    await openReviewLink(url, r, async (_manuscriptId, changeId) => {
      if (changeId === 'open-1') {
        return {
          action: 'focus',
          manuscriptId: 'book-1',
          sectionId: 'sec-1',
          changeId,
        };
      }
      return {
        action: 'history',
        manuscriptId: 'book-1',
        changeId,
        sectionId: 'sec-1',
        quote: changeId,
        kind: 'suggestion_insert',
        authorKind: 'agent',
        authorName: 'Line Editor',
        outcome: 'accepted',
        decidedBy: 'Sam',
        decidedAt: 1700000000,
      };
    });
    expect(r.selected).toHaveBeenCalledWith(['open-1']);
    expect(r.history.mock.calls.map((call) => call[0].changeId)).toEqual(['acc-1', 'acc-2']);
    expect(r.toast).not.toHaveBeenCalled();
    expect(r.focus).not.toHaveBeenCalled();
  });
});
