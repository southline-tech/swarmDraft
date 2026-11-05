import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import SendFeedbackModal from './SendFeedbackModal.vue';
import * as feedbackClient from './feedback-client';
import { ensureOverlayLayer } from './overlay/layer';

describe('SendFeedbackModal (#208)', () => {
  it('keeps draft fields when send fails', async () => {
    ensureOverlayLayer();
    vi.spyOn(feedbackClient.feedbackApi, 'send').mockRejectedValueOnce('offline');
    const w = mount(SendFeedbackModal, {
      props: { info: { version: '0.1.0', dataDir: '/x', schemaVersion: 1 } },
      attachTo: document.body,
      global: { stubs: { Teleport: { template: '<div><slot /></div>' } } },
    });
    await flushPromises();
    await vi.waitFor(() => w.find('[data-test="feedback-dialog"]').exists());
    await w.get('[data-test="feedback-description"]').setValue('Still here after failure');
    await w.get('[data-test="feedback-send"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="feedback-send-error"]').text()).toMatch(/internet/);
    expect((w.get('[data-test="feedback-description"]').element as HTMLTextAreaElement).value).toBe(
      'Still here after failure',
    );
    w.unmount();
  });

  it('omits excerpt unless include checkbox checked', async () => {
    ensureOverlayLayer();
    const send = vi.spyOn(feedbackClient.feedbackApi, 'send').mockResolvedValue(undefined);
    const props = {
      info: { version: '0.1.0', dataDir: '/x', schemaVersion: 1 },
      excerpt: 'Chapter one text',
    };
    const w1 = mount(SendFeedbackModal, {
      props,
      attachTo: document.body,
      global: { stubs: { Teleport: { template: '<div><slot /></div>' } } },
    });
    await flushPromises();
    await w1.get('[data-test="feedback-description"]').setValue('Report');
    await w1.get('[data-test="feedback-send"]').trigger('click');
    await flushPromises();
    expect(send.mock.calls[0]![0].excerpt).toBeUndefined();
    w1.unmount();
    send.mockClear();
    const w2 = mount(SendFeedbackModal, {
      props,
      attachTo: document.body,
      global: { stubs: { Teleport: { template: '<div><slot /></div>' } } },
    });
    await flushPromises();
    await w2.get('[data-test="feedback-description"]').setValue('Report');
    await w2.get('[data-test="feedback-include-text"]').setValue(true);
    await w2.get('[data-test="feedback-send"]').trigger('click');
    await flushPromises();
    expect(send.mock.calls[0]![0].excerpt).toBe('Chapter one text');
    w2.unmount();
  });

  it('shows validation for empty description', async () => {
    ensureOverlayLayer();
    const w = mount(SendFeedbackModal, {
      props: { info: null },
      attachTo: document.body,
      global: { stubs: { Teleport: { template: '<div><slot /></div>' } } },
    });
    await flushPromises();
    await w.get('[data-test="feedback-description"]').trigger('blur');
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toMatch(/Add a message/);
    w.unmount();
  });
});
