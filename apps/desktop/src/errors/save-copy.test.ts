import { describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import * as Y from 'yjs';
import { docToYDoc, importDocx, type DocNode } from '@coauthor/docx';
import type { Section } from '@coauthor/schema';
import { buildCopy, manuscriptDocx, saveCopy } from './save-copy';

function session(text = 'Unsaved words in memory') {
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text }] }],
  } as unknown as DocNode;
  const y = docToYDoc(doc);
  const outline: Section[] = [{ id: 's1', kind: 'chapter', title: 'Chapter 1', docId: 'd1' }];
  return { title: 'Sample Book', outline: shallowRef(outline), sections: new Map([['d1', y]]) };
}

describe('manuscriptDocx', () => {
  it('builds a .docx from the in-memory docs that reads back with the same text', () => {
    const s = session();
    const before = Y.encodeStateAsUpdate(s.sections.get('d1')!);
    const back = importDocx(manuscriptDocx(s));
    expect(JSON.stringify(back.sections)).toContain('Unsaved words in memory');
    // Read-only: the live doc is unchanged.
    expect(Y.encodeStateAsUpdate(s.sections.get('d1')!)).toEqual(before);
  });
});

function commentedSession() {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [
          { type: 'text', text: 'Before ' },
          {
            type: 'text',
            text: 'anchored words',
            marks: [{ type: 'bold' }, { type: 'comment_anchor', attrs: { id: 'c1' } }],
          },
          {
            type: 'text',
            text: ' after',
            marks: [{ type: 'comment_anchor', attrs: { id: 'c2' } }],
          },
        ],
      },
    ],
  } as unknown as DocNode;
  const s = session();
  s.sections.set('d1', docToYDoc(doc));
  return s;
}

describe('comments in the copy', () => {
  it('strips comment markers, keeps the text and other marks, and counts what was left out', async () => {
    const s = commentedSession();
    const before = Y.encodeStateAsUpdate(s.sections.get('d1')!);
    const { bytes, commentsLeftOut } = buildCopy(s);
    expect(commentsLeftOut).toBe(2);
    const back = JSON.stringify(importDocx(bytes).sections);
    expect(back).not.toContain('comment_anchor');
    expect(back).toContain('anchored words');
    expect(back).toContain('bold');
    expect(Y.encodeStateAsUpdate(s.sections.get('d1')!)).toEqual(before);
    const r = await saveCopy(s, { save: async () => 'D:\\b.docx' });
    expect(r).toEqual({ status: 'saved', path: 'D:\\b.docx', commentsLeftOut: 2 });
  });

  it('reports no comments left out when there were none', () => {
    expect(buildCopy(session()).commentsLeftOut).toBe(0);
  });
});

describe('saveCopy', () => {
  it('sends only the title and bytes; the backend picks the path', async () => {
    const save = vi.fn<(title: string, bytes: Uint8Array) => Promise<string | null>>(
      async () => 'D:\\Copies\\book.docx',
    );
    const r = await saveCopy(session(), { save });
    expect(r).toEqual({ status: 'saved', path: 'D:\\Copies\\book.docx', commentsLeftOut: 0 });
    expect(save).toHaveBeenCalledTimes(1);
    const [title, bytes] = save.mock.calls[0]!;
    expect(title).toBe('Sample Book');
    expect(JSON.stringify(importDocx(bytes).sections)).toContain('Unsaved words in memory');
  });

  it('reports cancelled when the dialog is cancelled', async () => {
    expect(await saveCopy(session(), { save: async () => null })).toEqual({
      status: 'cancelled',
    });
  });

  it('maps a write failure to plain copy, never raw text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveCopy(session(), {
      save: async () => {
        throw 'io: There is not enough space on the disk. (os error 112) C:\\secret\\path';
      },
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.error.code).toBe('disk-full');
    expect(JSON.stringify(r.error)).not.toMatch(/os error|secret/);
    log.mockRestore();
  });
});

describe('backend.saveManuscriptCopy', () => {
  it('passes no path to the write command', async () => {
    vi.resetModules();
    const invoke = vi.fn(async () => 'D:\\x.docx');
    vi.doMock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
    const { saveManuscriptCopy } = await import('../backend');
    expect(await saveManuscriptCopy('T', new Uint8Array([1, 2]))).toBe('D:\\x.docx');
    expect(invoke).toHaveBeenCalledWith('save_manuscript_copy', { title: 'T', bytes: [1, 2] });
    vi.doUnmock('@tauri-apps/api/core');
  });
});
