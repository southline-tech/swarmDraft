import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.vue';

describe('Rad55FocusModeEvidence (#55)', () => {
  const prev = globalThis.location;

  afterEach(() => {
    vi.stubGlobal('location', prev);
  });

  it('renders wp5 focus mode on the App shell (pill, no toolbar or status bar)', async () => {
    vi.stubGlobal('location', { ...prev, search: '?evidence=rad55&theme=light' });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(w.find('.shell.shell--focus-mode').exists()).toBe(true);
    expect(w.find('[data-test="rad55-focus-evidence"]').exists()).toBe(true);
    expect(w.find('[data-test="focus-pill"]').exists()).toBe(true);
    expect(w.find('[data-test="focus-words"]').exists()).toBe(true);
    expect(w.find('[data-test="focus-mode"]').exists()).toBe(false);
    expect(w.find('[data-test="status-bar"]').exists()).toBe(false);
    expect(w.find('[data-test="review"]').exists()).toBe(false);
    expect(w.find('.topbar').exists()).toBe(false);
    w.unmount();
  });
});
