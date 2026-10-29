/**
 * #107 continuous manuscript: scroll/focus wiring and window title (PM review on #128).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { readStructure } from '@coauthor/docx';
import { PRODUCT_NAME } from './lib/brand';
import { sessionFromDocx } from './manuscript-session';
import { sectionsInReadingOrder } from './manuscript-reading-order';
import { docWordCount } from './status/wordcount';

const setTitle = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: setTitle }),
}));
vi.mock('./backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('./backend')>();
  return {
    ...real,
    getAppInfo: async () => null,
    getRecoveryNotices: async () => [],
    getMigrationNotices: async () => [],
    openLatestManuscript: async () => null,
    listenOpeningProgress: async () => () => {},
  };
});
vi.mock('./close-flush', () => ({
  flushOnClose: async () => () => {},
}));

import App from './App.vue';

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
const settle = async () => {
  await flushPromises();
  await flushPromises();
};

describe('continuous manuscript (#107)', () => {
  let ioCallback: IntersectionObserverCallback | undefined;
  let scrollIntoView: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTitle.mockClear();
    ioCallback = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(cb: IntersectionObserverCallback) {
          ioCallback = cb;
        }
      },
    );
    scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    scrollIntoView.mockRestore();
    vi.unstubAllGlobals();
  });

  async function withManuscript() {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const session = sessionFromDocx(bytes(), 'm1');
    (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
    await settle();
    return { w, session };
  }

  it('outline click scrolls the section anchor and focuses that section body', async () => {
    const { w, session } = await withManuscript();
    const chapters = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    const target = chapters[1] ?? chapters[0]!;
    await w.get(`[data-test="section-${target.id}"]`).trigger('click');
    await settle();
    expect(scrollIntoView).toHaveBeenCalled();
    const pm = w.get(`[data-section-anchor="${target.id}"] .ProseMirror`);
    expect(pm.element.contains(document.activeElement)).toBe(true);
    w.unmount();
  });

  it('scroll-spy updates the outline highlight when a section dominates the viewport', async () => {
    const { w, session } = await withManuscript();
    const chapters = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    const initial = chapters[0]!;
    const target = chapters[1] ?? chapters[0]!;
    expect(w.get(`[data-test="section-${initial.id}"]`).classes()).toContain('selected');
    const anchor = w.get(`[data-section-anchor="${target.id}"]`).element;
    expect(ioCallback).toBeDefined();
    ioCallback!(
      [
        {
          isIntersecting: true,
          intersectionRatio: 0.9,
          target: anchor,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    await settle();
    expect(w.get(`[data-test="section-${target.id}"]`).classes()).toContain('selected');
    w.unmount();
  });

  it('renders each section ProseMirror text from its Y.Doc', async () => {
    const { w, session } = await withManuscript();
    await settle();
    for (const sec of sectionsInReadingOrder(session.outline.value)) {
      const doc = session.sections.get(sec.docId);
      if (!doc) continue;
      const words = docWordCount(doc);
      if (words < 2) continue;
      const pm = w.find(`[data-section-anchor="${sec.id}"] .ProseMirror`);
      expect(pm.exists(), sec.title).toBe(true);
      expect(pm.text().replace(/\s+/g, ' ').trim().length, sec.title).toBeGreaterThan(20);
      if (sec.kind === 'chapter') {
        expect(pm.findAll('p').length, sec.title).toBeGreaterThan(0);
      }
    }
    w.unmount();
  });

  it('keeps the review panel in a fixed rail outside the scroll column', async () => {
    const { w } = await withManuscript();
    await settle();
    const scroll = w.get('[data-test="continuous-manuscript"]').element;
    const rail = document.getElementById('continuous-review-rail');
    expect(rail).toBeTruthy();
    expect(scroll.contains(rail!)).toBe(false);
    expect(rail!.querySelector('[data-test="review"]')).toBeTruthy();
    w.unmount();
  });

  it('syncs the window title to the book name on open and product name on close', async () => {
    const { w, session } = await withManuscript();
    expect(document.title).toBe(session.title);
    expect(setTitle).toHaveBeenCalledWith(session.title);
    (w.vm as unknown as { closeSession: () => void }).closeSession();
    await settle();
    expect(document.title).toBe(PRODUCT_NAME);
    expect(setTitle).toHaveBeenLastCalledWith(PRODUCT_NAME);
    w.unmount();
  });
});
