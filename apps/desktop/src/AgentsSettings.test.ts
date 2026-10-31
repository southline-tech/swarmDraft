import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentsSettings from './AgentsSettings.vue';
import { agentDirectory, authorLabel } from './agent-names';
import type { Agent, AgentsApi, TokenInfo } from './backend';

function fakeApi() {
  const agents: Agent[] = [];
  const tokens: TokenInfo[] = [];
  const api: AgentsApi = {
    list: vi.fn(async () => agents.map((a) => ({ ...a }))),
    primaryId: vi.fn(async () => agents.find((a) => a.primary && !a.revokedAt)?.id ?? null),
    create: vi.fn(async (name: string, color: string) => {
      const a = {
        id: `a${agents.length}`,
        name,
        color,
        createdAt: 't',
        revokedAt: null,
        primary: false,
        lastSeenAt: null as string | null,
      };
      agents.push(a);
      return a;
    }),
    revoke: vi.fn(async (id: string) => {
      agents.find((a) => a.id === id)!.revokedAt = '2026-10-30T12:00:00.000Z';
    }),
    tokens: vi.fn(async (id: string) => tokens.filter((t) => t.agentId === id)),
    createToken: vi.fn(async (agentId: string, scopes = []) => {
      const info: TokenInfo = {
        id: `t${tokens.length}`,
        agentId,
        prefix: 'cat_abcdef',
        scopes,
        createdAt: 't',
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.push(info);
      return { token: 'cat_abcdefSECRET', info };
    }),
    revokeToken: vi.fn(async (id: string) => {
      tokens.find((t) => t.id === id)!.revokedAt = 't';
    }),
    setUserDisplayName: vi.fn(async (n: string) => n),
  };
  return api;
}

describe('AgentsSettings', () => {
  it('user-facing copy says "key", never "token" (#99)', async () => {
    const api = fakeApi();
    const w = mount(AgentsSettings, { props: { api, writeClipboard: async () => {} } });
    await flushPromises();
    await w.find('input[aria-label="Agent name"]').setValue('Sample Agent');
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(w.get('[data-test="token-once"]').text()).toContain('New key for Sample Agent');
    expect(w.text()).toContain("Copy this key now. This key won't be shown again.");
    expect(w.text()).toContain('New keys can');
    await w.find('[data-test="token-done"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="revoke-token"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="revoke-agent"]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-test="agent"]')).toHaveLength(0);
    expect(w.find('[data-test="removed-toggle"]').text()).toContain('Removed agents (1)');
    expect(w.find('[data-test="removed-toggle"]').attributes('aria-expanded')).toBe('false');
    await w.find('[data-test="removed-toggle"]').trigger('click');
    expect(w.get('[data-test="removed-agent"]').text()).toContain('Removed Oct 30');
    expect(w.get('[data-test="removed-agent"]').text()).not.toContain('New key');
    const visible = w
      .text()
      .replace(/cat_abcdef/g, '')
      .toLowerCase();
    expect(visible).not.toContain('token');
    expect(visible).not.toContain('revoke');
  });

  it('shows an error and keeps New key when mint fails after create (#187)', async () => {
    const api = fakeApi();
    api.createToken = vi.fn(async () => {
      throw 'could not mint key';
    });
    const w = mount(AgentsSettings, { props: { api } });
    await flushPromises();
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(api.create).toHaveBeenCalled();
    expect(w.findAll('[data-test="agent"]')).toHaveLength(1);
    expect(w.find('[data-test="token-once"]').exists()).toBe(false);
    expect(w.find('[data-test="error"]').text().length).toBeGreaterThan(0);
    expect(w.find('[data-test="mint"]').text()).toBe('New key');
  });

  it('shows the backend error when a name is reserved or taken (RAD-263)', async () => {
    const api = fakeApi();
    api.create = vi.fn(async () => {
      throw '"You" is reserved; choose another agent name';
    });
    const w = mount(AgentsSettings, { props: { api } });
    await flushPromises();
    await w.find('input[aria-label="Agent name"]').setValue('You');
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(w.find('[data-test="error"]').text()).toContain(
      'is reserved; choose another agent name',
    );
    expect(w.findAll('[data-test="agent"]')).toHaveLength(0);
  });

  it('creates an agent, shows a token once, lists and revokes it', async () => {
    const api = fakeApi();
    const w = mount(AgentsSettings, { props: { api } });
    await flushPromises();
    expect((w.find('input[aria-label="Agent name"]').element as HTMLInputElement).value).toBe(
      'Grok Bot',
    );
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith('Grok Bot', '#3366ff');
    expect(api.createToken).toHaveBeenCalledWith('a0', ['read', 'comment', 'suggest']);
    expect(w.findAll('[data-test="agent"]')).toHaveLength(1);
    // The editor and review UI pick up the new agent's name from this list (RAD-263).
    expect(authorLabel('agent:a0')).toBe('Grok Bot (bot)');
    agentDirectory.value = null;

    expect((w.find('[data-test="token-value"]').element as HTMLInputElement).value).toBe(
      'cat_abcdefSECRET',
    );
    expect(w.find('[data-test="token"]').text()).not.toContain('SECRET');

    await w.find('[data-test="token-done"]').trigger('click');
    expect(w.find('[data-test="token-once"]').exists()).toBe(false);
    expect(w.html()).not.toContain('SECRET');

    await w.find('[data-test="mint"]').trigger('click');
    await flushPromises();
    expect(api.createToken).toHaveBeenCalledTimes(2);
    await w.find('[data-test="revoke-token"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="token"]').text()).toContain('Turned off');
  });

  it('#187: mints and reveals a key when an agent is created', async () => {
    const api = fakeApi();
    const writeClipboard = vi.fn(async () => {});
    const w = mount(AgentsSettings, {
      props: { api, writeClipboard },
      attachTo: document.body,
    });
    await flushPromises();
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(api.createToken).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="token-once"]').exists()).toBe(true);
    expect(w.get('[data-test="token-once"]').text()).toContain('New key for Grok Bot');
    const keyInput = w.find('[data-test="token-value"]').element as HTMLInputElement;
    expect(document.activeElement).toBe(keyInput);
    expect(keyInput.selectionStart).toBe(0);
    expect(keyInput.selectionEnd).toBe('cat_abcdefSECRET'.length);
    expect(w.find('[data-test="copy-token"]').exists()).toBe(true);
    await w.find('[data-test="copy-token"]').trigger('click');
    await flushPromises();
    expect(writeClipboard).toHaveBeenCalledWith('cat_abcdefSECRET');
    await w.find('[data-test="token-done"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="token-once"]').exists()).toBe(false);

    const w2 = mount(AgentsSettings, { props: { api } });
    await flushPromises();
    expect(w2.find('[data-test="token-once"]').exists()).toBe(false);
    expect(w2.html()).not.toContain('SECRET');
    w.unmount();
    w2.unmount();
  });

  it('copies the token and confirms', async () => {
    const api = fakeApi();
    const writeClipboard = vi.fn(async () => {});
    const w = mount(AgentsSettings, { props: { api, writeClipboard } });
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(w.find('[data-test="copied"]').exists()).toBe(false);
    await w.find('[data-test="copy-token"]').trigger('click');
    await flushPromises();
    expect(writeClipboard).toHaveBeenCalledWith('cat_abcdefSECRET');
    expect(w.find('[data-test="copied"]').text()).toBe('Copied');
    expect(w.find('[data-test="copy-failed"]').exists()).toBe(false);
    expect(w.find('[data-test="token-once"]').exists()).toBe(true);
    const tok = w.find('[data-test="token-value"]');
    expect(tok.attributes('autocomplete')).toBe('off');
    expect(tok.attributes('autocapitalize')).toBe('off');
    expect(tok.attributes('autocorrect')).toBe('off');
    expect(tok.attributes('spellcheck')).toBe('false');
  });

  it.each([
    ['rejects', vi.fn(async (): Promise<void> => Promise.reject(new Error('denied')))],
    [
      'is unavailable',
      vi.fn((): Promise<void> => {
        throw new TypeError("Cannot read properties of undefined (reading 'writeText')");
      }),
    ],
  ])('keeps the token visible and selectable when the clipboard %s', async (_, writeClipboard) => {
    const api = fakeApi();
    const w = mount(AgentsSettings, {
      props: { api, writeClipboard: writeClipboard as (text: string) => Promise<void> },
      attachTo: document.body,
    });
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    await w.find('[data-test="copy-token"]').trigger('click');
    await flushPromises();
    expect(writeClipboard).toHaveBeenCalledWith('cat_abcdefSECRET');
    expect(w.find('[data-test="copied"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-failed"]').text()).toContain('press Ctrl+C to copy it');
    const input = w.find('[data-test="token-value"]');
    const el = input.element as HTMLInputElement;
    expect(w.find('[data-test="token-once"]').exists()).toBe(true);
    expect(el.value).toBe('cat_abcdefSECRET');
    expect(el.readOnly).toBe(true);
    // The failed copy itself focuses and fully selects the token.
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe('cat_abcdefSECRET'.length);
    el.setSelectionRange(0, 0);
    await input.trigger('focus');
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe('cat_abcdefSECRET'.length);

    // A retry that succeeds swaps the failure message for the confirmation.
    writeClipboard.mockImplementation(async () => undefined as never);
    await w.find('[data-test="copy-token"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="copy-failed"]').exists()).toBe(false);
    expect(w.find('[data-test="copied"]').text()).toBe('Copied');
    w.unmount();
  });

  it('clears the token when the page is hidden or the view unmounts', async () => {
    const api = fakeApi();
    const w = mount(AgentsSettings, { props: { api } });
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    window.dispatchEvent(new Event('pagehide'));
    await flushPromises();
    expect(w.html()).not.toContain('SECRET');

    await w.find('[data-test="mint"]').trigger('click');
    await flushPromises();
    expect(w.html()).toContain('SECRET');
    const vm = w.vm as unknown as { $: { setupState: { shownToken: unknown } } };
    w.unmount();
    expect(vm.$.setupState.shownToken).toBeNull();
  });

  it('maps other backend errors to plain copy, never raw text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = fakeApi();
    api.create = vi.fn(async () => {
      throw 'database is locked (code 5) at C:\\secret\\coauthor.db';
    });
    const w = mount(AgentsSettings, { props: { api } });
    await w.find('input[aria-label="Agent name"]').setValue('Helper');
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    const text = w.find('[data-test="error"]').text();
    expect(text).not.toMatch(/database is locked|secret|code 5/);
    expect(text.length).toBeGreaterThan(0);
    log.mockRestore();
  });

  it('shows backend errors', async () => {
    const api = fakeApi();
    api.create = vi.fn(async () => {
      throw 'name must be 1-64 characters';
    });
    const w = mount(AgentsSettings, { props: { api } });
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    expect(w.find('[data-test="error"]').text()).toContain('1-64');
  });

  describe('default clipboard (no writeClipboard prop)', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    afterEach(() => {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });
    function setClipboard(value: unknown) {
      Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
    }
    async function createAndCopy() {
      const w = mount(AgentsSettings, { props: { api: fakeApi() }, attachTo: document.body });
      await w.find('[data-test="create-agent"]').trigger('submit');
      await flushPromises();
      await w.find('[data-test="copy-token"]').trigger('click');
      await flushPromises();
      return w;
    }

    it('writes the token via navigator.clipboard and confirms', async () => {
      const writeText = vi.fn(async () => undefined);
      setClipboard({ writeText });
      const w = await createAndCopy();
      expect(writeText).toHaveBeenCalledWith('cat_abcdefSECRET');
      expect(w.find('[data-test="copied"]').text()).toBe('Copied');
      expect(w.find('[data-test="copy-failed"]').exists()).toBe(false);
      w.unmount();
    });

    it.each([
      [
        'writeText rejects',
        () => ({ writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }),
      ],
      ['navigator.clipboard is undefined', () => undefined],
    ])('falls back when %s', async (_, make) => {
      setClipboard(make());
      const w = await createAndCopy();
      expect(w.find('[data-test="copied"]').exists()).toBe(false);
      expect(w.find('[data-test="copy-failed"]').text()).toContain('press Ctrl+C to copy it');
      const el = w.find('[data-test="token-value"]').element as HTMLInputElement;
      expect(el.value).toBe('cat_abcdefSECRET');
      expect(document.activeElement).toBe(el);
      expect(el.selectionStart).toBe(0);
      expect(el.selectionEnd).toBe('cat_abcdefSECRET'.length);
      w.unmount();
    });
  });

  describe('Removed agents accordion (#192)', () => {
    const REMOVED_HELP =
      'Removed agents stay listed only while they still have suggestions or comments in your books. Name and color stay so old marks keep their attribution.';

    async function mountWithRemoved() {
      const api = fakeApi();
      api.list = vi.fn(async () => [
        {
          id: 'a0',
          name: 'Old Helper',
          color: '#a1452a',
          createdAt: 't',
          revokedAt: '2026-10-30T15:00:00.000Z',
          primary: false,
          lastSeenAt: null,
        },
      ]);
      const w = mount(AgentsSettings, { props: { api } });
      await flushPromises();
      return { w, api };
    }

    it('keeps active agents separate and hides removed rows until expanded', async () => {
      const api = fakeApi();
      api.list = vi.fn(async () => [
        {
          id: 'a0',
          name: 'Active',
          color: '#3366ff',
          createdAt: 't',
          revokedAt: null,
          primary: false,
          lastSeenAt: null,
        },
        {
          id: 'a1',
          name: 'Retired',
          color: '#2d794d',
          createdAt: 't',
          revokedAt: '2026-10-30T12:00:00.000Z',
          primary: false,
          lastSeenAt: null,
        },
      ]);
      const w = mount(AgentsSettings, { props: { api } });
      await flushPromises();
      expect(w.findAll('[data-test="agent"]')).toHaveLength(1);
      expect(w.get('[data-test="agent"]').text()).toContain('Active');
      expect(w.find('[data-test="removed-toggle"]').attributes('aria-expanded')).toBe('false');
      expect(w.find('[data-test="removed-agent"]').exists()).toBe(true);
      expect(w.find('[data-test="removed-agent"]').isVisible()).toBe(false);
      await w.find('[data-test="removed-toggle"]').trigger('click');
      expect(w.find('[data-test="removed-toggle"]').attributes('aria-expanded')).toBe('true');
      const row = w.get('[data-test="removed-agent"]');
      expect(row.text()).toContain('Retired');
      expect(row.text()).toContain('Removed Oct 30');
      expect(w.text()).toContain(REMOVED_HELP);
      expect(row.find('[data-test="mcp-status"]').exists()).toBe(false);
      expect(row.find('[data-test="mint"]').exists()).toBe(false);
    });

    it('does not fetch keys for removed agents', async () => {
      const { api } = await mountWithRemoved();
      expect(api.tokens).not.toHaveBeenCalled();
    });

    it('is keyboard operable on the accordion control', async () => {
      const { w } = await mountWithRemoved();
      const toggle = w.get('[data-test="removed-toggle"]');
      await toggle.trigger('keydown.enter');
      expect(toggle.attributes('aria-expanded')).toBe('true');
      expect(w.find('[data-test="removed-agent"]').exists()).toBe(true);
    });
  });

  describe('MCP connection status (#188)', () => {
    const fixedNow = Date.parse('2026-06-01T12:00:00.000Z');

    async function mountWithAgent(lastSeenAt: string | null) {
      const api = fakeApi();
      api.list = vi.fn(async () => [
        {
          id: 'a0',
          name: 'Helper',
          color: '#3366ff',
          createdAt: 't',
          revokedAt: null,
          primary: false,
          lastSeenAt,
        },
      ]);
      const w = mount(AgentsSettings, { props: { api, now: () => fixedNow } });
      await flushPromises();
      return w;
    }

    it('shows MCP connected within two minutes', async () => {
      const w = await mountWithAgent('2026-06-01T11:59:00.000Z');
      const row = w.get('[data-test="mcp-status"]');
      expect(row.text()).toBe('MCP connected');
      expect(row.classes()).toContain('ag__mcp--connected');
      expect(row.classes()).not.toContain('ag__mcp--muted');
    });

    it('shows last active minutes when older than two minutes', async () => {
      const w = await mountWithAgent('2026-06-01T11:30:00.000Z');
      const row = w.get('[data-test="mcp-status"]');
      expect(row.text()).toBe('Last active 30 min ago');
      expect(row.classes()).toContain('ag__mcp--muted');
    });

    it('shows not connected when last_seen_at is null', async () => {
      const w = await mountWithAgent(null);
      const row = w.get('[data-test="mcp-status"]');
      expect(row.text()).toBe('Not connected');
      expect(row.classes()).toContain('ag__mcp--muted');
    });

    it('clears the 30s refresh timer on unmount', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = fakeApi();
      const w = mount(AgentsSettings, { props: { api } });
      await flushPromises();
      expect(api.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
      expect(api.list).toHaveBeenCalledTimes(2);
      w.unmount();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
      expect(api.list).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });
});
