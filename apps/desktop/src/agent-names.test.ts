// RAD-263: agent display names instead of raw `agent:<id>` in the editor and review UI.
// Synthetic agents and text only.
import { afterEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ on: false, list: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (orig) => ({
  ...(await orig<object>()),
  isTauri: () => tauri.on,
}));
vi.mock('./backend', async (orig) => {
  const real = await orig<typeof import('./backend')>();
  return { ...real, agentsApi: { ...real.agentsApi, list: () => tauri.list() } };
});
import { flushPromises, mount } from '@vue/test-utils';
import type { SuggestionItem } from '@coauthor/editor';
import type { Agent } from './backend';
import {
  agentDirectory,
  agentLabel,
  agentName,
  authorLabel,
  refreshAgents,
  reloadOnFocus,
  resetAgentReloads,
  FOCUS_RELOAD_MS,
  REMOVED_AGENT,
  setAgents,
  UNNAMED_AGENT,
} from './agent-names';
import ManuscriptEditor from './ManuscriptEditor.vue';
import ReviewPanel from './review/ReviewPanel.vue';
import CommentsPanel from './comments/CommentsPanel.vue';

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  color: '#3366ff',
  createdAt: '2026-10-26T00:00:00Z',
  revokedAt: null,
});
const EVIL = '<img src=x onerror="alert(1)">Bot';

afterEach(() => {
  agentDirectory.value = null;
  resetAgentReloads();
  tauri.on = false;
  tauri.list.mockReset();
});

const by = (author: string) => ({ author, ts: '2026-10-26T00:00:00Z' });
const content = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The lamp ' },
        {
          type: 'text',
          text: 'guttered',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by('agent:a1') } }],
        },
        {
          type: 'text',
          text: 'flickered',
          marks: [{ type: 'suggestion_delete', attrs: { id: 's2', ...by('agent:gone') } }],
        },
        { type: 'text', text: ' twice.' },
      ],
    },
  ],
};

describe('agent display names (RAD-263)', () => {
  it('labels agents by name, with neutral fallbacks and people as stored', () => {
    expect(authorLabel('agent:a1')).toBe(UNNAMED_AGENT); // not loaded yet: never the raw id
    expect(agentLabel('a1', 'Stored Name')).toBe('Stored Name (agent)');
    expect(agentLabel('a1', 'agent:a1')).toBe(UNNAMED_AGENT);
    setAgents([agent('a1', 'Draft Helper'), agent('a2', '   ')]);
    expect(authorLabel('agent:a1')).toBe('Draft Helper (agent)');
    expect(authorLabel('agent:a2')).toBe(UNNAMED_AGENT);
    expect(authorLabel('agent:gone')).toBe(REMOVED_AGENT);
    expect(agentLabel('gone', 'Old Name')).toBe('Old Name (agent, removed)');
    expect(agentLabel('gone', 'agent:gone')).toBe(REMOVED_AGENT);
    setAgents([{ ...agent('a3', 'Retired Bot'), revokedAt: '2026-10-26T01:00:00Z' }]);
    expect(agentName('a3')).toEqual({ name: 'Retired Bot', note: '(revoked)', agent: true });
    expect(authorLabel('agent:a3')).toBe('Retired Bot (agent, revoked)');
    expect(authorLabel('Brett')).toBe('Brett');
    expect(authorLabel(undefined)).toBe('');
  });

  it('keeps the last list when a reload fails', async () => {
    setAgents([agent('a1', 'Draft Helper')]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refreshAgents(() => Promise.reject(new Error('locked')));
    expect(authorLabel('agent:a1')).toBe('Draft Helper (agent)');
    await refreshAgents(async () => [agent('a1', 'Renamed')]);
    expect(authorLabel('agent:a1')).toBe('Renamed (agent)');
    err.mockRestore();
  });

  it('shows names in the editor review list and mark hover text, live on rename', async () => {
    setAgents([agent('a1', 'Draft Helper')]);
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    const authors = () =>
      w.findAll('[data-test="review-author"] [data-test=agent-name]').map((a) => a.text());
    expect(authors()).toEqual(['Draft Helper', REMOVED_AGENT]);
    expect(w.findAll('[data-test="review-author"] [data-test=agent-tag]')).toHaveLength(2);
    expect(w.find('ins.suggestion-insert [title]').attributes('title')).toBe(
      'Added by Draft Helper (agent)',
    );
    expect(w.find('del.suggestion-delete [title]').attributes('title')).toBe(
      `Deleted by ${REMOVED_AGENT}`,
    );
    // Visible text and hover labels never show the raw id (it stays only in the mark's data attr).
    expect(w.text()).not.toContain('agent:');
    expect(w.findAll('[title]').some((t) => t.attributes('title')!.includes('agent:'))).toBe(false);

    setAgents([agent('a1', 'Line Editor')]);
    await flushPromises();
    expect(authors()[0]).toBe('Line Editor');
    expect(w.find('ins.suggestion-insert [title]').attributes('title')).toBe(
      'Added by Line Editor (agent)',
    );
    w.unmount();
  });

  it('never renders a name as HTML', async () => {
    setAgents([agent('a1', EVIL)]);
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('[data-test="review-author"] [data-test=agent-name]').text()).toBe(EVIL);
    expect(w.find('ins.suggestion-insert [title]').attributes('title')).toBe(
      `Added by ${EVIL} (agent)`,
    );

    const items: SuggestionItem[] = [
      { id: 's1', kind: 'suggestion_insert', author: 'agent:a1', ts: 't', text: 'x' },
    ];
    const p = mount(ReviewPanel, { props: { items } });
    expect(p.find('img').exists()).toBe(false);
    expect(p.find('[data-test=author-group] h3').text()).toContain(EVIL);
    w.unmount();
  });

  it('labels review panel groups and comments, keeping decisions keyed by the raw author', async () => {
    setAgents([agent('a1', 'Draft Helper')]);
    const items: SuggestionItem[] = [
      { id: 's1', kind: 'suggestion_insert', author: 'agent:a1', ts: 't', text: 'x' },
      { id: 's2', kind: 'suggestion_delete', author: 'agent:gone', ts: 't', text: 'y' },
    ];
    const p = mount(ReviewPanel, { props: { items } });
    const heads = p.findAll('[data-test=author-group] h3').map((h) => h.text());
    expect(heads[0]).toContain('Draft Helper');
    expect(heads[1]).toContain(REMOVED_AGENT);
    setAgents([{ ...agent('a1', 'Draft Helper'), revokedAt: 't' }]);
    await flushPromises();
    const revoked = p.find('[data-test=author-group] h3 [data-test=agent-note]');
    expect(revoked.text()).toBe('(revoked)');
    expect(revoked.classes()).toEqual(['agent-note']);
    setAgents([agent('a1', 'Draft Helper')]);
    expect(p.text()).not.toContain('agent:');
    await p.find('[data-test=accept-author]').trigger('click');
    expect(p.emitted('decide')![0]).toEqual([{ kind: 'author', author: 'agent:a1' }, 'accept']);

    const row = (
      id: string,
      authorKind: 'agent' | 'human',
      authorId: string,
      authorName: string,
    ) => ({
      id,
      threadId: 't1',
      body: 'Which lamp?',
      authorKind,
      authorId,
      authorName,
      createdAt: '2026-10-26T00:00:00Z',
    });
    const threads = [
      {
        id: 't1',
        anchorText: 'lamp',
        order: 0,
        resolved: false,
        orphan: 'none' as const,
        comments: [
          row('c1', 'agent', 'a1', 'agent:a1'),
          row('c2', 'agent', 'agent:gone', 'Old Name'),
          row('c3', 'human', 'me', 'Brett'),
        ],
      },
    ];
    const c = mount(CommentsPanel, { props: { threads } });
    const names = () =>
      c.findAll('[data-test=comment-author]').map((n) =>
        n
          .findAll('bdi, .agent-note')
          .map((x) => x.text())
          .join(' '),
      );
    expect(names()).toEqual(['Draft Helper', 'Old Name (removed)', 'Brett']);
    const note = c.findAll('[data-test=comment-author]')[1]!.find('[data-test=agent-note]');
    expect(note.text()).toBe('(removed)');
    expect(note.classes()).toContain('agent-note');
    setAgents([agent('a1', 'Line Editor')]);
    await flushPromises();
    expect(names()[0]).toBe('Line Editor');
  });

  it('truncates long names with the full name on hover, in neutral text colour', () => {
    const LONG = 'A Very Long Synthetic Agent Name That Keeps Going And Going';
    setAgents([agent('a1', LONG)]);
    const items: SuggestionItem[] = [
      { id: 's1', kind: 'suggestion_insert', author: 'agent:a1', ts: 't', text: 'x' },
    ];
    const p = mount(ReviewPanel, { props: { items } });
    const head = p.find('[data-test=author-group] h3');
    const name = head.find('[data-test=agent-name]');
    expect(name.attributes('title')).toBe(LONG);
    expect(name.classes()).toContain('agent-name');
    expect(head.find('.author-head-name').exists()).toBe(true);
    // The hashed hue is only a swatch (border), never the text colour.
    expect((head.element as HTMLElement).style.color).toBe('');

    const threads = [
      {
        id: 't1',
        anchorText: 'lamp',
        order: 0,
        resolved: false,
        orphan: 'none' as const,
        comments: [
          {
            id: 'c1',
            threadId: 't1',
            body: 'Hm.',
            authorKind: 'agent' as const,
            authorId: 'a1',
            authorName: LONG,
            createdAt: '2026-10-26T00:00:00Z',
          },
        ],
      },
    ];
    const c = mount(CommentsPanel, { props: { threads } });
    const author = c.find('[data-test=comment-author]');
    expect(author.find('[data-test=agent-name]').attributes('title')).toBe(LONG);
    expect((author.element as HTMLElement).style.color).toBe('');
  });

  it('reloads through the real agents API, dedupes, throttles focus, and drops stale replies', async () => {
    // Outside Tauri the default reload is a no-op.
    await refreshAgents();
    expect(tauri.list).not.toHaveBeenCalled();
    tauri.on = true;
    tauri.list.mockResolvedValue([agent('a1', 'Draft Helper')]);
    await Promise.all([refreshAgents(), refreshAgents()]);
    expect(tauri.list).toHaveBeenCalledTimes(1); // concurrent reloads share one request
    expect(authorLabel('agent:a1')).toBe('Draft Helper (agent)');

    // Failure through the real path keeps the last list.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.list.mockRejectedValueOnce(new Error('db locked'));
    await refreshAgents();
    expect(authorLabel('agent:a1')).toBe('Draft Helper (agent)');
    expect(err).toHaveBeenCalled();
    err.mockRestore();

    // Focus reloads are throttled.
    tauri.list.mockClear();
    await reloadOnFocus(10_000);
    await reloadOnFocus(10_000 + FOCUS_RELOAD_MS - 1);
    expect(tauri.list).toHaveBeenCalledTimes(1);
    await reloadOnFocus(10_000 + FOCUS_RELOAD_MS);
    expect(tauri.list).toHaveBeenCalledTimes(2);

    // A slow older reply never overwrites a newer one.
    let releaseOld!: (v: Agent[]) => void;
    const old = refreshAgents(() => new Promise((r) => (releaseOld = r)));
    await refreshAgents(async () => [agent('a1', 'Newest')]);
    releaseOld([agent('a1', 'Stale')]);
    await old;
    expect(authorLabel('agent:a1')).toBe('Newest (agent)');

    // A list set directly (AgentsSettings) also wins over a reload still in flight.
    let releaseLate!: (v: Agent[]) => void;
    const late = refreshAgents(() => new Promise((r) => (releaseLate = r)));
    setAgents([agent('a1', 'From settings')]);
    releaseLate([agent('a1', 'Late reply')]);
    await late;
    expect(authorLabel('agent:a1')).toBe('From settings (agent)');
  });

  it('isolates bidi text and strips bidi controls from labels', async () => {
    const RTL = '\u202Eמסייע 🤖';
    setAgents([agent('a1', RTL)]);
    expect(authorLabel('agent:a1')).toBe('מסייע 🤖 (agent)');
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    const title = w.find('ins.suggestion-insert [title]').attributes('title')!;
    expect(title).toBe('Added by מסייע 🤖 (agent)');
    expect(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(title)).toBe(false);
    const name = w.find('[data-test="review-author"] [data-test=agent-name]');
    expect(name.element.tagName).toBe('BDI');
    expect(name.attributes('dir')).toBe('auto');
    expect(name.text()).toBe('מסייע 🤖');
    w.unmount();
  });

  it('comments: injection-safe names and saved names, Agent tag, colour keyed by agent id', async () => {
    setAgents([agent('a1', EVIL)]);
    const row = (id: string, authorId: string, authorName: string) => ({
      id,
      threadId: 't1',
      body: 'Hm.',
      authorKind: 'agent' as const,
      authorId,
      authorName,
      createdAt: '2026-10-26T00:00:00Z',
    });
    const threads = (comments: ReturnType<typeof row>[]) => [
      {
        id: 't1',
        anchorText: 'lamp',
        order: 0,
        resolved: false,
        orphan: 'none' as const,
        comments,
      },
    ];
    const c = mount(CommentsPanel, {
      props: {
        threads: threads([row('c1', 'a1', 'Old snapshot'), row('c2', 'gone', `${EVIL} (revoked)`)]),
      },
    });
    expect(c.find('img').exists()).toBe(false);
    const authors = c.findAll('[data-test=comment-author]');
    expect(authors[0]!.find('[data-test=agent-name]').text()).toBe(EVIL);
    expect(authors[1]!.find('[data-test=agent-name]').text()).toBe(`${EVIL} (revoked)`);
    expect(authors[1]!.find('[data-test=agent-note]').text()).toBe('(removed)');
    expect(authors.every((a) => a.find('[data-test=agent-tag]').text() === 'Agent')).toBe(true);
    expect(c.find('.badge').exists()).toBe(false);

    // Same agent id, different saved names: same swatch colour.
    const style = (w: ReturnType<typeof mount>, i: number) =>
      w.findAll('[data-test=comment-author]')[i]!.attributes('style');
    const d = mount(CommentsPanel, {
      props: { threads: threads([row('c1', 'a1', 'Name One'), row('c2', 'a1', 'Name Two')]) },
    });
    expect(style(d, 0)).toBe(style(d, 1));
  });
});
