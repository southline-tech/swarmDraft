import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { FRAGMENT_NAME, readStructure } from '@coauthor/docx';
import { sessionFromDocx } from '../manuscript-session';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../App.vue';
import ShellsPreview from '../shells/ShellsPreview.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';

/**
 * #79: assertive regions are tested at the PARENT level. The region must already be in the DOM
 * before the error, and stay the same node when the error appears and when it clears.
 */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const settle = async () => {
  await flushPromises();
  await flushPromises();
};

describe('assertive error live regions at the parent level (#79)', () => {
  it('App: load-error region exists before the error and keeps its node through error, clear and remount', async () => {
    const w = mount(App, { attachTo: document.body });
    const region = () => w.get('[data-test="load-error-region"]');
    // Present (and empty) before any book or editor exists.
    expect(region().attributes('aria-live')).toBe('assertive');
    expect(region().attributes('role')).toBe('alert');
    expect(region().text()).toBe('');
    const node = region().element;

    await flushPromises();
    const bytes = new Uint8Array(
      readFileSync(
        resolve(__dirname, '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx'),
      ),
    );
    const session = sessionFromDocx(bytes, 'm1');
    const [, bad] = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    session.sections
      .get(bad!.docId)!
      .getXmlFragment(FRAGMENT_NAME)
      .insert(0, [new Y.XmlElement('synthetic_unknown_node')]);
    (w.vm as unknown as { open: (s: unknown) => void }).open(session);
    await settle();
    expect(region().element).toBe(node);

    await w.get(`[data-test="section-${bad!.id}"]`).trigger('click');
    await settle();
    expect(region().element).toBe(node);
    expect(region().text()).toContain('open read-only');
    expect(region().text()).not.toContain('Unknown node type');

    // Reload remounts the section; the region node survives and the error returns for bad content.
    await w.get('[data-test="reload"]').trigger('click');
    await settle();
    expect(region().element).toBe(node);
    expect(region().text()).toContain('open read-only');
    w.unmount();
  });

  it('ManuscriptEditor reports its load error to the parent and clears it on unmount', async () => {
    const bad = { type: 'doc', content: [{ type: 'table' }] };
    const w = mount(ManuscriptEditor, {
      props: { content: bad, externalLoadError: true },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.find('[data-test="load-error-region"]').exists()).toBe(false);
    const events = w.emitted('load-error')!.map((e) => e[0]);
    expect(events.at(-1)).toMatch(/\S/);
    w.unmount();
    expect(w.emitted('load-error')!.at(-1)![0]).toBe('');
  });

  it('ShellsPreview: error region exists before ob9 and keeps its node when the cards show and hide', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'wp1' } });
    const region = () => w.get('[data-test="preview-error-region"]');
    expect(region().attributes('aria-live')).toBe('assertive');
    expect(region().attributes('role')).toBe('alert');
    expect(region().text()).toBe('');
    const node = region().element;

    await w.get('[data-test="preview-select"]').setValue('ob9');
    expect(region().element).toBe(node);
    expect(region().findAll('[data-test="error-card"]')).toHaveLength(5);

    await w.get('[data-test="preview-select"]').setValue('wp1');
    expect(region().element).toBe(node);
    expect(region().text()).toBe('');
  });

  it('standalone ManuscriptEditor still mounts its own region empty, then fills the same node', async () => {
    const bad = { type: 'doc', content: [{ type: 'table' }] };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    const node = w.get('[data-test="load-error-region"]').element;
    await flushPromises();
    expect(w.get('[data-test="load-error-region"]').text()).toBe('');
    await frame();
    await w.vm.$nextTick();
    expect(w.get('[data-test="load-error-region"]').element).toBe(node);
    expect(w.get('[data-test="load-error-region"]').text()).toContain('open read-only');
    w.unmount();
  });
});
