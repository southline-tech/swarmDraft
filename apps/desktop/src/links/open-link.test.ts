import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OldChangeView from './OldChangeView.vue';
import { UNKNOWN_CHANGE_TOAST, openChangeLink, type ChangeLinkRoute } from './open-link';

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
    expect(view.textContent).toContain('Accepted');
    expect(view.textContent).toContain('Sam');
    expect(view.textContent).toContain('2023-11-14 22:13 UTC');
    expect(view.textContent).toContain('Insert');
    expect(view.textContent).toContain('guttered');
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
    expect(view.textContent).toContain('Rejected');
    expect(view.textContent).toContain('Riley');
    expect(view.textContent).toContain('Delete');
    expect(view.textContent).toContain('flickered');
    expect(r.failed).not.toHaveBeenCalled();
    w.unmount();
  });

  it('toasts an unknown id and does not raise an open error', async () => {
    const r = route();
    const result = await openChangeLink(url, r, async () => ({
      action: 'unknown',
      manuscriptId: 'book-1',
    }));
    expect(result).toBe('opened');
    expect(r.opened).toHaveBeenCalledWith('book-1');
    expect(r.toast).toHaveBeenCalledWith(UNKNOWN_CHANGE_TOAST);
    expect(r.failed).not.toHaveBeenCalled();
    expect(r.focus).not.toHaveBeenCalled();
    expect(r.history).not.toHaveBeenCalled();
  });
});
