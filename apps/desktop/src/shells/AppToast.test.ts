import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppToast from './AppToast.vue';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const props = { lead: 'Your book is open.', message: 'All 7 chapters.' };

describe('AppToast live region (#79)', () => {
  it('mounts an empty polite live region before the text, then fills that same node', async () => {
    const w = mount(AppToast, { props: { ...props, open: true } });
    const region = w.get('[data-test="toast-region"]');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');
    const node = region.element;
    await frame();
    await w.vm.$nextTick();
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(region.text()).toContain('Your book is open.');
    expect(region.text()).toContain('All 7 chapters.');
    expect(w.find('.toast').exists()).toBe(true);
  });

  it('closing clears the text but keeps the region node', async () => {
    const w = mount(AppToast, { props: { ...props, open: true } });
    await frame();
    await w.vm.$nextTick();
    const node = w.get('[data-test="toast-region"]').element;
    await w.setProps({ open: false });
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.textContent?.trim()).toBe('');
    await w.setProps({ open: true });
    expect(node.textContent).toContain('Your book is open.');
  });

  it('still emits dismiss from Got it', async () => {
    const w = mount(AppToast, { props: { ...props, open: true } });
    await frame();
    await w.vm.$nextTick();
    await w.get('[data-test="toast-dismiss"]').trigger('click');
    expect(w.emitted('dismiss')).toHaveLength(1);
  });
});
