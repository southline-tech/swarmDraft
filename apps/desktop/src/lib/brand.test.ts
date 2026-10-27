import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

// Swap the constant: if any visible title/welcome string bypasses PRODUCT_NAME, these fail.
vi.mock('./brand', () => ({ PRODUCT_NAME: 'ZzBrandProbe' }));

describe('PRODUCT_NAME', () => {
  it('drives the welcome heading, welcome copy and top bar name', async () => {
    localStorage.removeItem('coauthor.welcomed');
    const { default: App } = await import('../App.vue');
    const w = mount(App);
    await flushPromises();
    const welcome = w.find('[data-test="home-welcome"]').text();
    expect(welcome).toContain('Welcome to ZzBrandProbe');
    expect(welcome).toContain('ZzBrandProbe saves your work');
    expect(w.find('.topbar__name').text()).toBe('ZzBrandProbe');
    expect(w.text()).not.toMatch(/coAuthor|swarmDraft/);
    w.unmount();
  });
});
