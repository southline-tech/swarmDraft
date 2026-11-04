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
    expect(w.get('[data-test="feedback-status"]').text()).toMatch(/internet/);
    expect((w.get('[data-test="feedback-description"]').element as HTMLTextAreaElement).value).toBe(
      'Still here after failure',
    );
    w.unmount();
  });
});
