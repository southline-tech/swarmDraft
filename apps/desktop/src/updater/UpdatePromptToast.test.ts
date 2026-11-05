import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import UpdatePromptToast from './UpdatePromptToast.vue';

describe('UpdatePromptToast (#310 D fix)', () => {
  it('renders ready-to-install title and body', async () => {
    const w = mount(UpdatePromptToast, {
      props: {
        mode: 'available',
        version: '0.3.0',
        progress: null,
        manualMessage: null,
      },
    });
    await w.vm.$nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(w.text()).toContain('swarmDraft 0.3.0 is ready to install.');
    expect(w.text()).toContain('swarmDraft will restart. Your work is saved first.');
    expect(w.find('[data-test="update-toast-available"] .update-toast__icon--info').exists()).toBe(
      true,
    );
  });

  it('progress bar exposes download a11y labels', async () => {
    const w = mount(UpdatePromptToast, {
      props: {
        mode: 'downloading',
        version: '0.3.0',
        progress: 37,
        manualMessage: null,
      },
    });
    await w.vm.$nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    const bar = w.find('[data-test="update-progress"]');
    expect(bar.attributes('aria-label')).toBe('Downloading update');
    expect(bar.attributes('aria-valuetext')).toBe('37%');
  });

  it('install failure toast shows install copy', async () => {
    const w = mount(UpdatePromptToast, {
      props: {
        mode: 'manual-message',
        version: null,
        progress: null,
        manualMessage: 'install-failed',
      },
    });
    await w.vm.$nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(w.text()).toContain(
      "Couldn't install the update. Your work is saved — try again later.",
    );
  });

  it('emits later and dismiss from actions', async () => {
    const w = mount(UpdatePromptToast, {
      props: {
        mode: 'available',
        version: '1.0.0',
        progress: null,
        manualMessage: null,
      },
    });
    await w.vm.$nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    await w.find('[data-test="update-later"]').trigger('click');
    expect(w.emitted('later')).toHaveLength(1);

    const manual = mount(UpdatePromptToast, {
      props: {
        mode: 'manual-message',
        version: null,
        progress: null,
        manualMessage: 'up-to-date',
      },
    });
    await manual.vm.$nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    await manual.find('[data-test="update-dismiss"]').trigger('click');
    expect(manual.emitted('dismiss')).toHaveLength(1);
  });
});
