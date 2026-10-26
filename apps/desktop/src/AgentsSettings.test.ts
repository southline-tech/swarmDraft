import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentsSettings from './AgentsSettings.vue';
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

    await w.find('[data-test="mint"]').trigger('click');
    await flushPromises();
    expect(api.createToken).toHaveBeenCalledWith('a0', ['read', 'comment', 'suggest']);
    expect(w.find('[data-test="token-once"]').text()).toContain('cat_abcdefSECRET');
    expect(w.find('[data-test="token"]').text()).not.toContain('SECRET');

    await w.find('[data-test="token-once"] button').trigger('click');
    expect(w.find('[data-test="token-once"]').exists()).toBe(false);
    expect(w.html()).not.toContain('SECRET');

    await w.find('[data-test="revoke-token"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="token"]').text()).toContain('(revoked)');
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
});
