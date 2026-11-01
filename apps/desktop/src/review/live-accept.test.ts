// RAD-264, end to end: a live agent suggestion is accepted only by the author, through the
// trusted review path on the mounted editor (under review/ because it needs
// @swarmdraft/editor/trusted). The fixture comes from src-tauri/tests/live_updates.rs, which also
// checks that MCP tools/list offers no accept or reject tool. Synthetic text.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import { applyReviewDecision } from '@swarmdraft/editor/trusted';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { LIVE_POLL_MS, sessionFromStored } from '../manuscript-session';
import type { StoredManuscript, UpdatesSince } from '../backend';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../fixtures/mcp/live-agent-updates.json'), 'utf8'),
) as { stored: StoredManuscript; live: UpdatesSince };
const one = fixture.stored.sections[0]!;

afterEach(() => vi.useRealTimers());

const editorOf = (w: ReturnType<typeof mount>) =>
  (w.vm as unknown as { $: { setupState: { editor: Editor } } }).$.setupState.editor;

function suggestionTargets(e: Editor) {
  const out: {
    kind: 'suggestion_insert' | 'suggestion_delete';
    id: string;
    from: number;
    to: number;
  }[] = [];
  e.state.doc.descendants((n, pos) => {
    for (const m of n.marks)
      if (m.type.name === 'suggestion_insert' || m.type.name === 'suggestion_delete')
        out.push({ kind: m.type.name, id: String(m.attrs.id), from: pos, to: pos + n.nodeSize });
  });
  return out;
}

describe('accepting a live agent suggestion (RAD-264)', () => {
  it('is human-only: a plain strip is blocked, the trusted accept changes and saves the text', async () => {
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
    const e = editorOf(w);
    const page = () => w.find('.tiptap');
    expect(page().find('ins.suggestion-insert').text()).toBe('guttered');

    // An untrusted local transaction that strips the agent's marks is filtered out.
    const targets = suggestionTargets(e);
    expect(targets.map((t) => t.kind).sort()).toEqual(['suggestion_delete', 'suggestion_insert']);
    const strip = e.state.tr;
    for (const t of targets) strip.removeMark(t.from, t.to, e.schema.marks[t.kind]);
    e.view.dispatch(strip);
    expect(suggestionTargets(e)).toHaveLength(2);
    expect(page().text()).toContain('flickeredguttered');

    // The author accepts through the trusted review path.
    const ok = applyReviewDecision(e.view, {
      targets: targets.map(({ kind, id }) => ({ kind, id })),
      decision: 'accept',
    });
    expect(ok).toBe(true);
    expect(page().text()).toContain('The lantern guttered twice.');
    expect(page().find('ins, del').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await session.flush();
    expect(saved.length).toBeGreaterThan(0);

    // It persists: the stored state plus the agent's and the author's saved updates reload as
    // the accepted text.
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Uint8Array.from(one.state));
    for (const u of fixture.live.updates)
      if (u.docId === one.docId) Y.applyUpdate(reload, Uint8Array.from(u.update));
    for (const u of saved) Y.applyUpdate(reload, u);
    const again = mount(ManuscriptEditor, { props: { doc: reload }, attachTo: document.body });
    await flushPromises();
    expect(again.find('.tiptap').text()).toContain('The lantern guttered twice.');
    expect(again.find('ins, del').exists()).toBe(false);
    expect(again.find('.comment-anchor').text()).toBe('lantern');

    again.unmount();
    await session.close({ discard: true });
    w.unmount();
  });
});
