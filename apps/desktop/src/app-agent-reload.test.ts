// RAD-263: App reloads agent names on mount and (throttled) on window focus.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const calls = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), focus: vi.fn(async () => {}) }));
vi.mock('./agent-names', async (orig) => ({
  ...(await orig<object>()),
  refreshAgents: calls.refresh,
  reloadOnFocus: calls.focus,
}));

import App from './App.vue';

describe('App agent-name reloads', () => {
  it('loads on mount, reloads on focus, and stops listening on unmount', async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(calls.refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    expect(calls.focus).toHaveBeenCalledTimes(1);
    w.unmount();
    window.dispatchEvent(new Event('focus'));
    expect(calls.focus).toHaveBeenCalledTimes(1);
  });
});
