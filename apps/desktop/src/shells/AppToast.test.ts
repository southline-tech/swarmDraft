import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppToast from './AppToast.vue';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe('AppToast live region (#79)', () => {
  it('mounts an empty polite live region before the text, then fills that same node', async () => {
    const w = mount(AppToast, {
      props: { lead: 'Your book is open.', message: 'All 7 chapters.' },
    });
    const region = w.find('[data-test="toast"]');
    expect(region.exists()).toBe(true);
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');
    const node = region.element;

    await frame();
    await w.vm.$nextTick();
    const after = w.find('[data-test="toast"]');
    expect(after.element).toBe(node);
    expect(after.text()).toContain('Your book is open.');
    expect(after.text()).toContain('All 7 chapters.');
    expect(after.find('.toast').exists()).toBe(true);
    w.unmount();
  });

  it('still emits dismiss from Got it', async () => {
    const w = mount(AppToast, { props: { lead: 'L', message: 'M' } });
    await frame();
    await w.vm.$nextTick();
    await w.find('[data-test="toast-dismiss"]').trigger('click');
    expect(w.emitted('dismiss')).toHaveLength(1);
  });
});
