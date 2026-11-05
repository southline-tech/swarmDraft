import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import FeedbackPrompt from './FeedbackPrompt.vue';
import type { FeedbackApi, FeedbackPendingSummary } from './feedback-client';
import { ensureOverlayLayer } from './overlay/layer';
import { overlayWrap } from './overlay/queries';

const row = (over: Partial<FeedbackPendingSummary> = {}): FeedbackPendingSummary => ({
  id: 'fb-1',
  agentId: 'agent-1',
  agentName: 'Line Bot',
  area: 'editor',
  type: 'bug',
  description: 'Export failed',
  excerpt: 'private line',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:05:00Z',
  ...over,
});

function mountPrompt(pending: FeedbackPendingSummary[]) {
  document.body.innerHTML = '';
  ensureOverlayLayer();
  let queue = pending.map((p) => ({ ...p }));
  const api: FeedbackApi = {
    listPending: vi.fn(async () => queue.map((p) => ({ ...p }))),
    approve: vi.fn(async (id) => {
      queue = queue.filter((p) => p.id !== id);
    }),
    deny: vi.fn(async (id) => {
      queue = queue.filter((p) => p.id !== id);
    }),
    send: vi.fn(),
  };
  const w = mount(FeedbackPrompt, {
    props: { api },
    attachTo: document.body,
  });
  return { w, api };
}

describe('FeedbackPrompt (#208)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    ensureOverlayLayer();
  });

  it('strips excerpt on approve unless checkbox checked', async () => {
    const { api } = mountPrompt([row()]);
    await flushPromises();
    expect(overlayWrap('[data-test="feedback-bot-excerpt"]').text()).toContain('private line');
    const box = overlayWrap('[data-test="feedback-bot-include-excerpt"]')
      .element as HTMLInputElement;
    expect(box.checked).toBe(false);
    await overlayWrap('[data-test="feedback-allow"]').trigger('click');
    await flushPromises();
    expect(api.approve).toHaveBeenCalledWith('fb-1', { includeExcerpt: false });
  });

  it('passes includeExcerpt when author opts in', async () => {
    const { api } = mountPrompt([row()]);
    await flushPromises();
    await overlayWrap('[data-test="feedback-bot-include-excerpt"]').setValue(true);
    await overlayWrap('[data-test="feedback-allow"]').trigger('click');
    await flushPromises();
    expect(api.approve).toHaveBeenCalledWith('fb-1', { includeExcerpt: true });
  });

  it('Esc defers without deny', async () => {
    mountPrompt([row()]);
    await flushPromises();
    overlayWrap('[data-test="feedback-bot-dialog"]').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushPromises();
    expect(document.querySelector('[data-test="feedback-bot-dialog"]')).toBeNull();
  });
});
