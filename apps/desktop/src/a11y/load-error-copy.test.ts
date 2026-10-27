import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { FRAGMENT_NAME, readStructure } from '@coauthor/docx';
import App from '../App.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { sessionFromDocx } from '../manuscript-session';
import { PRODUCT_NAME } from '../lib/brand';
import { SECTION_LOAD_ERROR_COPY } from '../errors/map-error';

/** #89: the load-error banner shows writer copy only; the parser message goes to the console. */
const WRITER_COPY = `Part of this section uses formatting ${PRODUCT_NAME} can't edit yet, so it's open read-only and changes won't be saved.`;
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

describe('load-error banner copy (#89)', () => {
  it('copy constant matches the issue and uses PRODUCT_NAME', () => {
    expect(SECTION_LOAD_ERROR_COPY).toBe(WRITER_COPY);
  });

  it('App with the real editor: writer copy, no raw parser text, .sh-btn Reload, raw text logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const session = sessionFromDocx(new Uint8Array(readFileSync(fixture)), 'm1');
    const [, bad] = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    session.sections
      .get(bad!.docId)!
      .getXmlFragment(FRAGMENT_NAME)
      .insert(0, [new Y.XmlElement('synthetic_unknown_node')]);
    (w.vm as unknown as { open: (s: unknown) => void }).open(session);
    await settle();
    await w.get(`[data-test="section-${bad!.id}"]`).trigger('click');
    await settle();

    const region = w.get('[data-test="load-error-region"]');
    expect(region.attributes('role')).toBe('alert');
    const text = region.text().replace(/\s+/g, ' ');
    expect(text).toContain(WRITER_COPY);
    expect(text).not.toMatch(/synthetic_unknown_node|Unknown node|node type/i);
    expect(text).not.toContain('does not support');
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
      el.textContent?.includes(WRITER_COPY),
    );
    expect(alerts).toHaveLength(1);
    const reload = region.get('[data-test="reload"]');
    expect(reload.classes()).toContain('sh-btn');
    expect(reload.text()).toBe('Reload section');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/synthetic_unknown_node/);
    w.unmount();
    warn.mockRestore();
  });

  it('standalone editor banner: writer copy, no raw text, .sh-btn Reload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = mount(ManuscriptEditor, {
      props: { content: { type: 'doc', content: [{ type: 'table' }] } },
      attachTo: document.body,
    });
    await settle();
    const banner = w.get('[data-test="load-error"]');
    const text = banner.text().replace(/\s+/g, ' ');
    expect(text).toContain(WRITER_COPY);
    expect(text).not.toMatch(/table|Unknown node|does not support/i);
    expect(banner.get('[data-test="reload"]').classes()).toContain('sh-btn');
    w.unmount();
    warn.mockRestore();
  });
});
