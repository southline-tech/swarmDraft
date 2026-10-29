import { describe, expect, it, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc, yDocToDoc } from '@coauthor/docx';
import { listSuggestions } from '@coauthor/editor';
import { applyReviewDecision } from './review/apply';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './fixtures/sample';
import {
  DEFAULT_PROFILE,
  PROFILE_KEY,
  TRACKING_KEY,
  TRACK_PROMPT_SEEN_KEY,
  loadProfile,
  loadTrackPromptSeen,
  loadTracking,
  saveProfile,
  seedProfileForTracking,
} from './settings/prefs';

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

async function mountedEditor(
  opts: {
    storage?: ReturnType<typeof store>;
    computerName?: string;
    content?: typeof SAMPLE_DOC;
  } = {},
) {
  const ydoc = docToYDoc((opts.content ?? SAMPLE_DOC) as never);
  const w = mount(ManuscriptEditor, {
    props: { doc: ydoc, storage: opts.storage, computerName: opts.computerName },
    attachTo: document.body,
  });
  await flushPromises();
  const editor = (w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor })
    .editor;
  return { w, ydoc, editor };
}

describe('Track changes toggle (#57)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'light';
  });

  it('persists off/on (tc1/tc2) and shows status when on', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s });
    const t = w.get('[data-test="track-changes"]');
    expect(t.attributes('aria-pressed')).toBe('false');
    expect(t.text()).toBe('Track changes');
    expect(w.find('[data-test="status-tracking-off"]').text()).toContain('Track changes is off');
    await t.trigger('click');
    expect(t.attributes('aria-pressed')).toBe('true');
    expect(t.text()).toContain('Track changes · On');
    expect(w.find('[data-test="status-tracking"]').exists()).toBe(true);
    expect(w.find('[data-test="status-tracking-as"]').text()).toContain('Your changes show as');
    expect(loadTracking(s)).toBe(true);
    w.unmount();
    const again = await mountedEditor({ storage: s });
    expect(again.w.get('[data-test="track-changes"]').attributes('aria-pressed')).toBe('true');
    again.w.unmount();
  });

  it('shows the tc3 name prompt once, seeds profile, and saves dismissal', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s, computerName: 'Rowan Vale' });
    await w.get('[data-test="track-changes"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(true);
    expect(w.get('[data-test="name-prompt"]').attributes('role')).toBe('status');
    expect(w.text()).toContain("We used your computer's name");
    expect(loadProfile(s)).toEqual({ name: 'Rowan Vale', color: DEFAULT_PROFILE.color });
    await w.get('[data-test="name-prompt-ok"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    expect(loadTrackPromptSeen(s)).toBe(true);
    await w.get('[data-test="track-changes"]').trigger('click');
    await w.get('[data-test="track-changes"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    w.unmount();
  });

  it('opens inline name & color from the prompt change action', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s, computerName: 'Writer' });
    await w.get('[data-test="track-changes"]').trigger('click');
    await w.get('[data-test="name-prompt-change"]').trigger('click');
    expect(w.find('[data-test="settings-name-color"]').exists()).toBe(true);
    await w.get('[data-test="settings-cancel"]').trigger('click');
    expect(w.find('[data-test="settings-name-color"]').exists()).toBe(false);
    expect(loadTrackPromptSeen(s)).toBe(true);
    w.unmount();
  });

  it('uses neutral copy when no computer name is available', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s });
    await w.get('[data-test="track-changes"]').trigger('click');
    expect(w.text()).not.toContain("We used your computer's name");
    expect(w.text()).toContain('change your name and color');
    w.unmount();
  });

  it('uses token-backed track toggle in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const { w } = await mountedEditor({ storage: store() });
      const t = w.get('[data-test="track-changes"]');
      expect(t.classes()).toContain('sh-track');
      await t.trigger('click');
      expect(t.attributes('aria-pressed')).toBe('true');
      w.unmount();
    }
  });

  it('does not re-seed an existing saved profile', () => {
    const s = store();
    saveProfile({ name: 'Kept Name', color: 5 }, s);
    expect(seedProfileForTracking('Other', s)).toEqual({ name: 'Kept Name', color: 5 });
  });

  it('tc3 name prompt closes on Esc and returns focus to the track toggle', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s, computerName: 'Ada' });
    const toggle = w.get('[data-test="track-changes"]');
    await toggle.trigger('click');
    const prompt = w.get('[data-test="name-prompt"]');
    expect(document.activeElement?.getAttribute('data-test')).toBe('name-prompt-ok');
    await prompt.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    expect(document.activeElement).toBe(toggle.element);
    w.unmount();
  });

  it('restores tracking without the prompt when it was already seen', async () => {
    const s = store({
      [TRACKING_KEY]: '1',
      [TRACK_PROMPT_SEEN_KEY]: '1',
      [PROFILE_KEY]: JSON.stringify({ name: 'Saved', color: 2 }),
    });
    const { w } = await mountedEditor({ storage: s });
    expect(w.get('[data-test="track-changes"]').attributes('aria-pressed')).toBe('true');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    w.unmount();
  });
});

const PLAIN = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'Hello world.' }],
    },
  ],
} as const;

describe('Human track changes (#126)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function trackingStore(name = 'Writer') {
    return store({
      [TRACKING_KEY]: '1',
      [TRACK_PROMPT_SEEN_KEY]: '1',
      [PROFILE_KEY]: JSON.stringify({ name, color: 3 }),
    });
  }

  it('records insert, delete, and replace under the writer profile', async () => {
    const { w, editor } = await mountedEditor({
      storage: trackingStore('Kim'),
      content: PLAIN as never,
    });
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
    await flushPromises();
    let items = listSuggestions(editor.getJSON() as never);
    expect(items).toEqual([
      expect.objectContaining({ author: 'Kim', kind: 'suggestion_insert', text: '!' }),
    ]);
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.view.dispatch(editor.state.tr.deleteSelection());
    await flushPromises();
    expect(
      listSuggestions(editor.getJSON() as never).some((i) => i.kind === 'suggestion_delete'),
    ).toBe(true);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.view.dispatch(editor.state.tr.insertText('Howdy'));
    await flushPromises();
    items = listSuggestions(editor.getJSON() as never).filter((i) => i.author === 'Kim');
    const howdy = items.find((i) => i.kind === 'suggestion_insert' && i.text === 'Howdy');
    expect(howdy).toBeDefined();
    expect(items.some((i) => i.kind === 'suggestion_delete' && i.id === howdy!.id)).toBe(true);
    expect(w.find('[data-test="agent-name"]').text()).toContain('Kim');
    w.unmount();
  });

  it('lists human suggestions in the review panel and author filter', async () => {
    const { w, editor } = await mountedEditor({
      storage: trackingStore('Alex'),
      content: PLAIN as never,
    });
    editor.view.dispatch(editor.state.tr.insertText('?', 1));
    await flushPromises();
    expect(w.findAll('[data-test="item"]').length).toBeGreaterThan(0);
    expect(w.find('[data-test="item"] [data-test="agent-name"]').text()).toContain('Alex');
    await w.get('[data-test="filter-toggle"]').trigger('click');
    expect(w.find('[data-test="filter-option"] .name').text()).toContain('Alex');
    w.unmount();
  });

  it('accept, bulk reject, and undo on human suggestions', async () => {
    const { w, editor } = await mountedEditor({
      storage: trackingStore(),
      content: PLAIN as never,
    });
    editor.view.dispatch(editor.state.tr.insertText(' tail', editor.state.doc.content.size - 1));
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never)).toHaveLength(1);
    expect(editor.commands.undo()).toBe(true);
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never)).toHaveLength(0);
    editor.view.dispatch(editor.state.tr.insertText(' kept', editor.state.doc.content.size - 1));
    await flushPromises();
    const id = listSuggestions(editor.getJSON() as never)[0]!.id;
    applyReviewDecision(editor.view, {
      targets: [{ kind: 'suggestion_insert', id }],
      decision: 'accept',
    });
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never)).toHaveLength(0);
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never)).toHaveLength(1);
    await w.get('[data-test="reject-all"]').trigger('click');
    await w.get('[data-test="confirm-yes"]').trigger('click');
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never)).toHaveLength(0);
    w.unmount();
  });

  it('persists tracked suggestions across remount and Y.Doc round-trip', async () => {
    const s = trackingStore('Export');
    const { w, ydoc, editor } = await mountedEditor({ storage: s, content: PLAIN as never });
    editor.view.dispatch(editor.state.tr.insertText('x', 1));
    await flushPromises();
    const afterEdit = yDocToDoc(ydoc);
    w.unmount();
    const { w: w2, editor: again } = await mountedEditor({
      storage: s,
      content: afterEdit as never,
    });
    expect(listSuggestions(again.getJSON() as never).some((i) => i.author === 'Export')).toBe(true);
    w2.unmount();
    const ydoc2 = docToYDoc(afterEdit as never);
    expect(listSuggestions(yDocToDoc(ydoc2)).some((i) => i.author === 'Export')).toBe(true);
  });
});
