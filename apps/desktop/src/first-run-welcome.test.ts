/** First-run welcome flag (RAD-268 / ob4, #34 Batch B). */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

describe('first-run welcome flag (#34 ob4)', () => {
  it('honours the legacy coauthor.welcomed key and migrates to swarmdraft.welcomed', async () => {
    localStorage.removeItem('swarmdraft.welcomed');
    localStorage.setItem('coauthor.welcomed', '1');
    const w = mount(App);
    await flushPromises();
    expect(w.find('[data-test="home-welcome"]').exists()).toBe(false);
    expect(w.find('[data-test="home-open"]').exists()).toBe(true);
    expect(localStorage.getItem('swarmdraft.welcomed')).toBe('1');
    w.unmount();
  });
});
