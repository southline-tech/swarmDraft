import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { FRAGMENT_NAME, readStructure } from '@coauthor/docx';
import App from '../App.vue';
import { sessionFromDocx } from '../manuscript-session';

/**
 * #82: App-level, with the real ManuscriptEditor. A section whose stored content does not fit
 * the schema is announced exactly once, in App's always-mounted region.
 */
const fixture = resolve(
  __dirname,
  '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const settle = async () => {
  await flushPromises();
  await frame();
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
};

describe('App load-error region with the real editor (#82)', () => {
  it('announces a bad section once, clears on a healthy one, and Reload keeps typed text', async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const session = sessionFromDocx(new Uint8Array(readFileSync(fixture)), 'm1');
    const [good, bad] = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    // Synthetic corruption: a node type the editor schema doesn't know.
    const badDoc = session.sections.get(bad!.docId)!;
    badDoc.getXmlFragment(FRAGMENT_NAME).insert(0, [new Y.XmlElement('synthetic_unknown_node')]);
    (w.vm as unknown as { open: (s: unknown) => void }).open(session);
    await settle();

    const region = () => w.get('[data-test="load-error-region"]');
    const node = region().element;
    // Designer: the full-width banner sits in flow below the title bar, never over it.
    const header = w.get('header.topbar').element;
    expect(header.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.contains(node)).toBe(false);
    const alertsWithError = () =>
      Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
        el.textContent?.includes('open read-only'),
      );

    await w.get(`[data-test="section-${bad!.id}"]`).trigger('click');
    await settle();
    expect(alertsWithError()).toHaveLength(1);
    expect(alertsWithError()[0]).toBe(node);
    expect(
      region()
        .text()
        .match(/open read-only/g),
    ).toHaveLength(1);

    await w.get(`[data-test="section-${good!.id}"]`).trigger('click');
    await settle();
    expect(region().element).toBe(node);
    expect(region().text()).toBe('');
    expect(alertsWithError()).toHaveLength(0);
    const editor = (
      w.get('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    editor.commands.insertContent('Synthetic survives reload');
    await settle();

    await w.get(`[data-test="section-${bad!.id}"]`).trigger('click');
    await settle();
    expect(region().element).toBe(node);
    expect(alertsWithError()).toHaveLength(1);

    await w.get('[data-test="reload"]').trigger('click');
    await settle();
    expect(region().element).toBe(node);
    expect(alertsWithError()).toHaveLength(1);

    await w.get(`[data-test="section-${good!.id}"]`).trigger('click');
    await settle();
    expect(w.get('.tiptap').text()).toContain('Synthetic survives reload');
    expect(region().text()).toBe('');
    w.unmount();
  });
});
