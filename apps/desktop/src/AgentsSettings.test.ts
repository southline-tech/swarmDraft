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
    create: vi.fn(async (name: string, color: string) => {
      const a = { id: `a${agents.length}`, name, color, createdAt: 't', revokedAt: null };
      agents.push(a);
      return a;
    }),
    revoke: vi.fn(async (id: string) => {
      agents.find((a) => a.id === id)!.revokedAt = 't';
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
  };
  return api;
}

describe('AgentsSettings', () => {
  it('shows the backend error when a name is reserved or taken (RAD-263)', async () => {
    const api = fakeApi();
    api.create = vi.fn(async () => {
      throw '"Author" is reserved; choose another agent name';
    });
    const w = mount(AgentsSettings, { props: { api } });
    await flushPromises();
    await w.find('input[aria-label="Agent name"]').setValue('Author');
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
    expect(w.findAll('[data-test="agent"]')).toHaveLength(1);
    // The editor and review UI pick up the new agent's name from this list (RAD-263).
    expect(authorLabel('agent:a0')).toBe('Grok Bot (agent)');
    agentDirectory.value = null;

    await w.find('[data-test="mint"]').trigger('click');
    await flushPromises();
    expect(api.createToken).toHaveBeenCalledWith('a0', ['read', 'comment', 'suggest']);
    expect((w.find('[data-test="token-value"]').element as HTMLInputElement).value).toBe(
      'cat_abcdefSECRET',
    );
    expect(w.find('[data-test="token"]').text()).not.toContain('SECRET');

    await w.find('[data-test="token-done"]').trigger('click');
    expect(w.find('[data-test="token-once"]').exists()).toBe(false);
    expect(w.html()).not.toContain('SECRET');

    await w.find('[data-test="revoke-token"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="token"]').text()).toContain('(revoked)');
  });

  it('copies the token and confirms', async () => {
    const api = fakeApi();
    const writeClipboard = vi.fn(async () => {});
    const w = mount(AgentsSettings, { props: { api, writeClipboard } });
    await w.find('[data-test="create-agent"]').trigger('submit');
    await flushPromises();
    await w.find('[data-test="mint"]').trigger('click');
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
    await w.find('[data-test="mint"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="copy-token"]').trigger('click');
    await flushPromises();
    expect(writeClipboard).toHaveBeenCalledWith('cat_abcdefSECRET');
    expect(w.find('[data-test="copied"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-failed"]').text()).toContain('copy it manually');
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
    await w.find('[data-test="mint"]').trigger('click');
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
    async function mintAndCopy() {
      const w = mount(AgentsSettings, { props: { api: fakeApi() }, attachTo: document.body });
      await w.find('[data-test="create-agent"]').trigger('submit');
      await flushPromises();
      await w.find('[data-test="mint"]').trigger('click');
      await flushPromises();
      await w.find('[data-test="copy-token"]').trigger('click');
      await flushPromises();
      return w;
    }

    it('writes the token via navigator.clipboard and confirms', async () => {
      const writeText = vi.fn(async () => undefined);
      setClipboard({ writeText });
      const w = await mintAndCopy();
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
      const w = await mintAndCopy();
      expect(w.find('[data-test="copied"]').exists()).toBe(false);
      expect(w.find('[data-test="copy-failed"]').text()).toContain('copy it manually');
      const el = w.find('[data-test="token-value"]').element as HTMLInputElement;
      expect(el.value).toBe('cat_abcdefSECRET');
      expect(document.activeElement).toBe(el);
      expect(el.selectionStart).toBe(0);
      expect(el.selectionEnd).toBe('cat_abcdefSECRET'.length);
      w.unmount();
    });
  });
});
