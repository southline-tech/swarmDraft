import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PairingPrompt from './PairingPrompt.vue';
import { type PairingApi, type PairingSummary } from './pairing-client';
import type { Agent } from './backend';
import { ensureOverlayLayer } from './overlay/layer';
import { overlayWrap, queryAllInOverlay, queryInOverlay } from './overlay/queries';

const sample = (id: string, name: string): PairingSummary => ({
  id,
  name,
  color: '#3366ff',
  requestedScopes: ['comment', 'suggest'],
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:05:00Z',
});

const agentStub = (): Agent => ({
  id: 'new-agent',
  name: 'Helper',
  color: '#3366ff',
  createdAt: 't',
  revokedAt: null,
  primary: false,
  lastSeenAt: null,
});

function mountPrompt(
  pending: PairingSummary[],
  overrides: Partial<PairingApi> = {},
  subscribe?: (cb: (pairingId: string) => void) => () => void,
) {
  document.body.innerHTML = '';
  ensureOverlayLayer();
  let queue = pending.map((p) => ({ ...p }));
  const api: PairingApi = {
    listPending: vi.fn(async () => queue.map((p) => ({ ...p }))),
    approve: vi.fn(async (id) => {
      queue = queue.filter((p) => p.id !== id);
      return agentStub();
    }),
    deny: vi.fn(async (id) => {
      queue = queue.filter((p) => p.id !== id);
    }),
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
    ensureOverlayLayer();
  });

  it('opens on pairing-requested with Deny focused', async () => {
    let notify: ((id: string) => void) | undefined;
    const subscribe = (cb: (id: string) => void) => {
      notify = cb;
      return () => {};
    };
    const { api } = mountPrompt([], {}, subscribe);
    await flushPromises();
    expect(queryInOverlay('[data-test="pairing-dialog"]')).toBeNull();
    (api.listPending as ReturnType<typeof vi.fn>).mockResolvedValue([sample('p1', 'Helper')]);
    notify!('p1');
    await flushPromises();
    expect(queryInOverlay('[data-test="pairing-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(overlayWrap('[data-test="pairing-deny"]').element);
  });

  it('calls deny on Esc', async () => {
    const { api } = mountPrompt([sample('p1', 'Helper')]);
    await flushPromises();
    await overlayWrap('[data-test="pairing-dialog"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(api.deny).toHaveBeenCalledWith('p1');
  });

  it('calls approve with pairing id on Allow', async () => {
    const { api } = mountPrompt([sample('p1', 'Helper')]);
    await flushPromises();
    await overlayWrap('[data-test="pairing-allow"]').trigger('click');
    await flushPromises();
    expect(api.approve).toHaveBeenCalledWith('p1', ['comment', 'suggest'], null);
  });

  it('shows only row Deny/Allow for a single pending request (#269)', async () => {
    mountPrompt([sample('p1', 'Only')]);
    await flushPromises();
    expect(queryInOverlay('[data-test="pairing-deny-all"]')).toBeNull();
    expect(queryAllInOverlay('[data-test="pairing-deny"]')).toHaveLength(1);
    expect(queryAllInOverlay('[data-test="pairing-allow"]')).toHaveLength(1);
  });

  it('shows every pending request in one dialog (#269)', async () => {
    mountPrompt([sample('p1', 'First'), sample('p2', 'Second')]);
    await flushPromises();
    const dialog = overlayWrap('[data-test="pairing-dialog"]');
    expect(dialog.text()).toContain('First');
    expect(dialog.text()).toContain('Second');
    await overlayWrap('[data-test="pairing-deny-p1"]').trigger('click');
    await flushPromises();
    expect(queryAllInOverlay('[data-test="pairing-row"]')).toHaveLength(1);
    expect(overlayWrap('[data-test="pairing-dialog"]').text()).toContain('Second');
  });

  it('uses ap1 title, body, access chips, and Esc hint', async () => {
    mountPrompt([sample('p1', 'Helper')]);
    await flushPromises();
    const dialog = overlayWrap('[data-test="pairing-dialog"]');
    expect(dialog.text()).toContain('Allow Helper to connect?');
    expect(dialog.text()).toContain('Bots on this computer are asking to connect');
    expect(dialog.text()).toContain('Comment');
    expect(dialog.text()).toContain('Esc denies all pending requests');
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
    document.body.innerHTML = '';
    ensureOverlayLayer();
    mount(PairingPrompt, { props: { api }, attachTo: document.body });
    await flushPromises();
    await overlayWrap('[data-test="pairing-allow"]').trigger('click');
    await flushPromises();
    expect(queryInOverlay('[data-test="pairing-dialog"]')).toBeNull();
  });

  it('disables buttons while a decision is in flight', async () => {
    let resolveDeny!: () => void;
    const deny = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveDeny = r;
        }),
    );
    mountPrompt([sample('p1', 'Wait')], { deny });
    await flushPromises();
    void overlayWrap('[data-test="pairing-deny"]').trigger('click');
    await flushPromises();
    expect(overlayWrap('[data-test="pairing-deny"]').attributes('disabled')).toBeDefined();
    expect(overlayWrap('[data-test="pairing-allow"]').attributes('disabled')).toBeDefined();
    resolveDeny();
    await flushPromises();
  });

  it('shows inline error on failure and keeps the dialog', async () => {
    const { api } = mountPrompt([sample('p1', 'Nope')], {
      deny: vi.fn(async () => {
        throw 'database is locked';
      }),
    });
    await flushPromises();
    await overlayWrap('[data-test="pairing-deny"]').trigger('click');
    await flushPromises();
    expect(api.deny).toHaveBeenCalled();
    expect(queryInOverlay('[data-test="pairing-error"]')).not.toBeNull();
    expect(queryInOverlay('[data-test="pairing-dialog"]')).not.toBeNull();
  });

  it('shows a clear message on duplicate agent name (#270)', async () => {
    mountPrompt([sample('p1', 'QA Bot 2')], {
      approve: vi.fn(async () => {
        throw 'an agent named "QA Bot 2" already exists; choose another name';
      }),
    });
    await flushPromises();
    await overlayWrap('[data-test="pairing-allow"]').trigger('click');
    await flushPromises();
    expect(overlayWrap('[data-test="pairing-error"]').text()).toContain(
      'A bot named QA Bot 2 already exists',
    );
  });

  it('loads pending pairings on mount', async () => {
    const { api } = mountPrompt([sample('p0', 'Early')]);
    await flushPromises();
    expect(api.listPending).toHaveBeenCalled();
    expect(overlayWrap('[data-test="pairing-dialog"]').text()).toContain('Early');
  });
});

describe('mcpAgentStatus', () => {
  it('formats connected, relative, and missing states', async () => {
    const { mcpAgentStatus } = await import('./mcp-agent-status');
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    expect(mcpAgentStatus('2026-06-01T11:59:00.000Z', now).text).toBe('Assistant connected');
    expect(mcpAgentStatus('2026-06-01T11:15:00.000Z', now).text).toBe('Last active 45 min ago');
    expect(mcpAgentStatus(null, now).text).toBe('Not connected');
  });
});
