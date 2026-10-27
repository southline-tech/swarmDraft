// RAD-263: App reloads agent names on mount and (throttled) on window focus, through the real
// refreshAgents/reloadOnFocus path; only the Tauri bridge is faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const bridge = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('./backend', async (orig) => {
  const real = await orig<typeof import('./backend')>();
  return { ...real, agentsApi: { ...real.agentsApi, list: () => bridge.list() } };
});
vi.mock('@tauri-apps/api/core', async (orig) => ({
  ...(await orig<object>()),
  // Only agent-names asks; the rest of the app keeps running in browser mode.
  isTauri: () => new Error().stack?.includes('agent-names') ?? false,
}));

import App from './App.vue';
import { agentDirectory, authorLabel, FOCUS_RELOAD_MS, resetAgentReloads } from './agent-names';

const agent = (id: string, name: string) => ({
  id,
  name,
  color: '#3366ff',
  createdAt: '2026-10-26T00:00:00Z',
  revokedAt: null,
});

afterEach(() => {
  vi.useRealTimers();
  agentDirectory.value = null;
  resetAgentReloads();
  bridge.list.mockReset();
});

describe('App agent-name reloads', () => {
  it('loads on mount, throttles focus reloads, keeps names on error, stops on unmount', async () => {
    vi.useFakeTimers({ now: 100_000, toFake: ['Date'] });
    bridge.list.mockResolvedValue([agent('a1', 'Draft Helper')]);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(authorLabel('agent:a1')).toBe('Draft Helper (bot)');

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(bridge.list).toHaveBeenCalledTimes(2); // second focus is throttled

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.list.mockRejectedValueOnce(new Error('db locked'));
    vi.setSystemTime(100_000 + FOCUS_RELOAD_MS);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(bridge.list).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalled();
    expect(authorLabel('agent:a1')).toBe('Draft Helper (bot)');
    err.mockRestore();

    w.unmount();
    vi.setSystemTime(100_000 + 3 * FOCUS_RELOAD_MS);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(bridge.list).toHaveBeenCalledTimes(3);
  });
});
