import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PairingPrompt from './PairingPrompt.vue';
import { type PairingApi, type PairingSummary } from './pairing-client';

const sample = (id: string, name: string): PairingSummary => ({
  id,
  name,
  color: '#3366ff',
  requestedScopes: ['comment', 'suggest'],
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:05:00Z',
});

function mountPrompt(
  pending: PairingSummary[],
  overrides: Partial<PairingApi> = {},
  subscribe?: (cb: (pairingId: string) => void) => () => void,
) {
  const api: PairingApi = {
    listPending: vi.fn(async () => pending.map((p) => ({ ...p }))),
    approve: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    ...overrides,
  };
  const w = mount(PairingPrompt, {
    props: { api, subscribePairingRequested: subscribe },
    attachTo: document.body,
  });
  return { w, api };
}

describe('PairingPrompt', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens on pairing-requested with Deny focused', async () => {
    let notify: ((id: string) => void) | undefined;
    const subscribe = (cb: (id: string) => void) => {
      notify = cb;
      return () => {};
    };
    const { w, api } = mountPrompt([], {}, subscribe);
    await flushPromises();
    expect(w.find('[data-test="pairing-dialog"]').exists()).toBe(false);
    (api.listPending as ReturnType<typeof vi.fn>).mockResolvedValue([sample('p1', 'Helper')]);
    notify!('p1');
    await flushPromises();
    expect(w.find('[data-test="pairing-dialog"]').exists()).toBe(true);
    expect(document.activeElement).toBe(w.get('[data-test="pairing-deny"]').element);
  });

  it('calls deny on Esc', async () => {
    const { w, api } = mountPrompt([sample('p1', 'Helper')]);
    await flushPromises();
    await w.get('[data-test="pairing-dialog"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(api.deny).toHaveBeenCalledWith('p1');
  });

  it('calls approve with pairing id on Allow', async () => {
    const { w, api } = mountPrompt([sample('p1', 'Helper')]);
    await flushPromises();
    await w.get('[data-test="pairing-allow"]').trigger('click');
    await flushPromises();
    expect(api.approve).toHaveBeenCalledWith('p1', ['comment', 'suggest']);
  });

  it('shows the second request after the first resolves', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([sample('p1', 'First'), sample('p2', 'Second')])
      .mockResolvedValueOnce([sample('p2', 'Second')]);
    const api: PairingApi = {
      listPending: list,
      approve: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
    };
    const w = mount(PairingPrompt, { props: { api }, attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('First');
    await w.get('[data-test="pairing-deny"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Second');
    expect(w.text()).not.toContain('Allow First');
  });

  it('closes quietly when the pairing expired', async () => {
    const api: PairingApi = {
      listPending: vi
        .fn()
        .mockResolvedValueOnce([sample('p1', 'Gone')])
        .mockResolvedValueOnce([]),
      approve: vi.fn(async () => {
        throw 'pairing p1 not found';
      }),
      deny: vi.fn(async () => {}),
    };
    const w = mount(PairingPrompt, { props: { api }, attachTo: document.body });
    await flushPromises();
    await w.get('[data-test="pairing-allow"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="pairing-dialog"]').exists()).toBe(false);
  });

  it('disables buttons while a decision is in flight', async () => {
    let resolveDeny!: () => void;
    const deny = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveDeny = r;
        }),
    );
    const { w } = mountPrompt([sample('p1', 'Wait')], { deny });
    await flushPromises();
    void w.get('[data-test="pairing-deny"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="pairing-deny"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test="pairing-allow"]').attributes('disabled')).toBeDefined();
    resolveDeny();
    await flushPromises();
  });

  it('shows inline error on failure and keeps the dialog', async () => {
    const { w, api } = mountPrompt([sample('p1', 'Nope')], {
      deny: vi.fn(async () => {
        throw 'database is locked';
      }),
    });
    await flushPromises();
    await w.get('[data-test="pairing-deny"]').trigger('click');
    await flushPromises();
    expect(api.deny).toHaveBeenCalled();
    expect(w.find('[data-test="pairing-error"]').exists()).toBe(true);
    expect(w.find('[data-test="pairing-dialog"]').exists()).toBe(true);
  });

  it('loads pending pairings on mount', async () => {
    const { w, api } = mountPrompt([sample('p0', 'Early')]);
    await flushPromises();
    expect(api.listPending).toHaveBeenCalled();
    expect(w.text()).toContain('Early');
  });
});

describe('mcpAgentStatus', () => {
  it('formats connected, relative, and missing states', async () => {
    const { mcpAgentStatus } = await import('./mcp-agent-status');
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    expect(mcpAgentStatus('2026-06-01T11:59:00.000Z', now).text).toBe('MCP connected');
    expect(mcpAgentStatus('2026-06-01T11:15:00.000Z', now).text).toBe('Last active 45 min ago');
    expect(mcpAgentStatus(null, now).text).toBe('Not connected');
  });
});
