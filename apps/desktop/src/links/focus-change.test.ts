/**
 * A change link focuses the mark in the continuous manuscript, including after it moved (#117, #123).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { Editor } from '@tiptap/core';
import { docToYDoc } from '@swarmdraft/docx';
import * as Y from 'yjs';
import ContinuousManuscript from '../ContinuousManuscript.vue';
import { sampleOutline } from '../fixtures/outline-sample';

vi.mock('../backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('../backend')>();
  return {
    ...real,
    sectionReviewMeta: vi.fn(async () => ({
      comments: [],
      authorSavedNames: {},
      suggestionReasons: {},
    })),
  };
});

const suggestion = (text: string, id: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text,
          marks: [{ type: 'suggestion_insert', attrs: { id, author: 'ada', ts: 't' } }],
        },
      ],
    },
  ],
});

describe('focus a linked change (#117, #123)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects a moved change in its new section', async () => {
    const outline = sampleOutline();
    const sections = new Map<string, Y.Doc>();
    for (const sec of outline) {
      const json =
        sec.id === 'ch-1'
          ? {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Here.' }] }],
            }
          : sec.id === 'ch-2'
            ? suggestion('Later harbor', 'chg-moved')
            : null;
      sections.set(sec.docId, json ? docToYDoc(json as never) : new Y.Doc());
    }
    const w = mount(ContinuousManuscript, {
      props: { outline, sections, selectedId: 'ch-1', reloadToken: 0 },
      attachTo: document.body,
    });
    await flushPromises();
    const vm = w.vm as unknown as {
      focusResolvedChange: (sectionId: string, changeId: string) => Promise<void>;
    };
    await vm.focusResolvedChange('ch-2', 'chg-moved');
    await flushPromises();
    const section = document.querySelector('[data-section-anchor="ch-2"]')!;
    const mark = section.querySelector('ins[data-id="chg-moved"]');
    expect(mark?.textContent).toBe('Later harbor');
    const editor = (section.querySelector('.tiptap') as unknown as { editor: Editor }).editor;
    const selected = editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
    );
    expect(selected).toBe('Later harbor');
    expect(w.emitted('update:selectedId')?.at(-1)).toEqual(['ch-2']);
    w.unmount();
  });
});
