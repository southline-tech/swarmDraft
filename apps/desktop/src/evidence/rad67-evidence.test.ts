import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Rad67EditorChromeEvidence from './Rad67EditorChromeEvidence.vue';

describe('Rad67EditorChromeEvidence (#67)', () => {
  const prev = window.location;

  beforeEach(() => {
    vi.stubGlobal('location', { ...prev, search: '?evidence=rad67&frame=wp1' });
  });

  afterEach(() => {
    vi.stubGlobal('location', prev);
  });

  it('wp1 loads manuscript content and review items without a load error', async () => {
    const w = mount(Rad67EditorChromeEvidence, { attachTo: document.body });
    await flushPromises();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await flushPromises();
    expect(w.find('[data-test="load-error"]').exists()).toBe(false);
    expect(w.find('[data-test="empty-load-failed"]').exists()).toBe(false);
    expect(w.find('.tiptap').text()).toContain('The tide went out');
    expect(w.findAll('[data-test="item"]').length).toBeGreaterThan(0);
    expect(w.find('[data-test="page"]').exists()).toBe(true);
    w.unmount();
  });
});
