// RAD-258 end to end on the mounted editor: the review panel's Accept goes through the trusted
// path, the accepted text survives a reload from the saved updates (existing session persistence,
// unchanged), and undo/redo keep the decision record in step with the page. Synthetic fixture.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import type { DecisionRecord } from '@swarmdraft/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import { LIVE_POLL_MS, sessionFromStored } from '../manuscript-session';
import type { StoredManuscript, UpdatesSince } from '../backend';
import { allowReviewEdits } from '@swarmdraft/editor/trusted';
import { REVIEW_COLLAPSED_KEY } from './review-state';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../fixtures/mcp/live-agent-updates.json'), 'utf8'),
) as { stored: StoredManuscript; live: UpdatesSince };
const one = fixture.stored.sections[0]!;

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const editorOf = (w: ReturnType<typeof mount>) =>
  (w.vm as unknown as { $: { setupState: { editor: Editor } } }).$.setupState.editor;

async function openLive() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const saved: Uint8Array[] = [];
  const save = vi.fn(async (_doc: string, u: Uint8Array) => void saved.push(u));
  let served = false;
  const poll = vi.fn(async (after: number): Promise<UpdatesSince> => {
    if (served) return { cursor: Math.max(after, fixture.live.cursor), updates: [] };
    served = true;
    return fixture.live;
  });
  const session = sessionFromStored(
    fixture.stored,
    null,
    { save, debounceMs: 10 },
    undefined,
    poll,
  );
  const w = mount(ManuscriptEditor, {
    props: { doc: session.sections.get(one.docId)! },
    attachTo: document.body,
  });
  await flushPromises();
  await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10);
  await flushPromises();
  return { w, session, saved };
}
const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
/** SAMPLE_DOC plus a second change: an insert in the last paragraph. */
const TWO_CHANGES = {
  ...SAMPLE_DOC,
  content: [
    ...SAMPLE_DOC.content!.slice(0, -1),
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Morning came ' },
        {
          type: 'text',
          text: 'softly',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'two-s2', ...by } }],
        },
        { type: 'text', text: ' late.' },
      ],
    },
  ],
};
const lastDecisions = (w: ReturnType<typeof mount>) =>
  (w.emitted('decisions')?.at(-1)?.[0] ?? []) as DecisionRecord[];

describe('review panel in the editor (RAD-258)', () => {
  it('accepts from the panel and the accepted text persists across a reload', async () => {
    const { w, session, saved } = await openLive();
    const page = () => w.find('.tiptap');
    // One replacement (delete + insert sharing an id) is one change.
    expect(w.findAll('[data-test=item]')).toHaveLength(1);
    expect(w.find('[data-test=counter]').text()).toBe('1 of 1');

    await w.find('[data-test=accept-all]').trigger('click');
    expect(w.find('[data-test=confirm]').text()).toMatch(/Accept 1 change from Unnamed agent\?/);
    await w.find('[data-test=confirm-yes]').trigger('click');
    await flushPromises();
    expect(page().text()).toContain('The lantern guttered twice.');
    expect(w.find('[data-test=empty]').exists()).toBe(true);
    const recs = lastDecisions(w);
    expect(recs.map((r) => [r.kind, r.status, r.decidedBy]).sort()).toEqual([
      ['suggestion_delete', 'accepted', 'author'],
      ['suggestion_insert', 'accepted', 'author'],
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await session.flush();
    expect(saved.length).toBeGreaterThan(0);
    // Restart: the stored state, the agent's updates and the author's saves reload as accepted.
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Uint8Array.from(one.state));
    for (const u of fixture.live.updates)
      if (u.docId === one.docId) Y.applyUpdate(reload, Uint8Array.from(u.update));
    for (const u of saved) Y.applyUpdate(reload, u);
    const again = mount(ManuscriptEditor, { props: { doc: reload }, attachTo: document.body });
    await flushPromises();
    expect(again.find('.tiptap').text()).toContain('The lantern guttered twice.');
    expect(again.find('ins, del').exists()).toBe(false);
    expect(again.find('[data-test=empty]').exists()).toBe(true);

    again.unmount();
    await session.close({ discard: true });
    w.unmount();
  });

  it('keeps the decision record in step with the page across undo and redo', async () => {
    const { w, session } = await openLive();
    const e = editorOf(w);
    const page = () => w.find('.tiptap');
    await w.findAll('[data-test=item]')[0]!.find('[data-test=accept]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(0);
    expect(lastDecisions(w)).toHaveLength(2); // both parts of the replacement

    e.commands.undo();
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(1);
    expect(page().find('ins.suggestion-insert').exists()).toBe(true);
    expect(lastDecisions(w)).toEqual([]);

    e.commands.redo();
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(0);
    expect(lastDecisions(w)).toHaveLength(2);

    await session.close({ discard: true });
    w.unmount();
  });

  it('steps with Previous/Next and the shortcuts, moving the caret to each change', async () => {
    const w = mount(ManuscriptEditor, { props: { content: TWO_CHANGES }, attachTo: document.body });
    await flushPromises();
    const e = editorOf(w);
    const marksAtCaret = () => {
      const { from } = e.state.selection;
      return e.state.doc.nodeAt(from)?.marks.map((m) => m.type.name) ?? [];
    };
    await w.find('[data-test=next]').trigger('click');
    expect(w.find('[data-test=counter]').text()).toBe('2 of 2');
    expect(marksAtCaret()).toContain('suggestion_insert');
    expect(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)).toBe('softly');
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true }),
    );
    await flushPromises();
    expect(w.find('[data-test=counter]').text()).toBe('1 of 2');
    expect(marksAtCaret()).toContain('suggestion_delete'); // the replacement starts with its delete
    expect(w.findAll('[data-test=item]')[0]!.classes()).toContain('current');
    w.unmount();
  });

  it('Ctrl+Backslash collapses the panel to a rail and the state persists', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }));
    await flushPromises();
    expect(w.find('[data-test=review-rail]').exists()).toBe(true);
    expect(w.find('[data-test=badge]').text()).toBe('1');
    expect(localStorage.getItem(REVIEW_COLLAPSED_KEY)).toBe('1');
    w.unmount();
    const again = mount(ManuscriptEditor, {
      props: { content: SAMPLE_DOC },
      attachTo: document.body,
    });
    await flushPromises();
    expect(again.find('[data-test=review-rail]').exists()).toBe(true);
    again.unmount();
  });

  it('scopes accept/reject shortcuts to the open panel and the editor', async () => {
    const w = mount(ManuscriptEditor, { props: { content: TWO_CHANGES }, attachTo: document.body });
    await flushPromises();
    const accept = (target: EventTarget) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    const count = () => w.findAll('[data-test=item]').length;
    // Focus in some other text field outside the editor: ignored.
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    accept(field);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    accept(editable);
    await flushPromises();
    expect(count()).toBe(2);
    // Collapsed panel: ignored. The collapse toggle itself still works.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }));
    await flushPromises();
    accept(w.find('.tiptap').element);
    await flushPromises();
    expect(w.find('[data-test=badge]').text()).toBe('2');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }));
    await flushPromises();
    // Panel open, focus in the editor: acts on the current change.
    accept(w.find('.tiptap').element);
    await flushPromises();
    expect(count()).toBe(1);
    field.remove();
    editable.remove();
    w.unmount();
  });

  it('bulk accept only decides the changes that were listed when the confirmation opened', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const e = editorOf(w);
    await w.find('[data-test=accept-all]').trigger('click');
    // A bot change arrives while the confirmation is open.
    const end = e.state.doc.content.size - 1;
    const mark = e.schema.marks.suggestion_insert!.create({ id: 'late-1', ...by });
    // Stands in for the live sync path, which may add review marks.
    e.view.dispatch(allowReviewEdits(e.state.tr.insert(end, e.schema.text(' Late.', [mark]))));
    await flushPromises();
    expect(w.findAll('[data-test=item]')).toHaveLength(2);
    expect(w.find('[data-test=confirm]').text()).toContain('Accept 1 change');
    await w.find('[data-test=confirm-yes]').trigger('click');
    await flushPromises();
    const left = w.findAll('[data-test=item]');
    expect(left).toHaveLength(1);
    expect(left[0]!.find('[data-test=ins]').text()).toBe('Late.');
    expect(w.find('.tiptap').text()).toContain('The lantern guttered twice');
    w.unmount();
  });
});
