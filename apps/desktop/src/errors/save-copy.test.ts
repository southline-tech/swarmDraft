import { describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import * as Y from 'yjs';
import { docToYDoc, exportDocx, importDocx, type DocNode } from '@coauthor/docx';
import type { Section } from '@coauthor/schema';
import { buildCopy, manuscriptDocx, saveCopy, type BuildCopyDeps } from './save-copy';

function session(text = 'Unsaved words in memory') {
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text }] }],
  } as unknown as DocNode;
  const y = docToYDoc(doc);
  const outline: Section[] = [{ id: 's1', kind: 'chapter', title: 'Chapter 1', docId: 'd1' }];
  return {
    id: 'm1',
    title: 'Sample Book',
    outline: shallowRef(outline),
    sections: new Map([['d1', y]]),
  };
}

const noComments: BuildCopyDeps = { loadComments: async () => [] };

describe('manuscriptDocx', () => {
  it('builds a .docx from the in-memory docs that reads back with the same text', async () => {
    const s = session();
    const before = Y.encodeStateAsUpdate(s.sections.get('d1')!);
    const back = importDocx(await manuscriptDocx(s, noComments));
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

const copyComments: BuildCopyDeps = {
  loadComments: async () => [
    {
      sectionId: 's1',
      threadId: 'c1',
      body: 'Note one',
      authorName: 'Ann',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      sectionId: 's1',
      threadId: 'c2',
      body: 'Note two',
      authorName: 'Bo',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ],
};

describe('comments in the copy', () => {
  it('keeps anchors, loads comment bodies, and round-trips through the docx package', async () => {
    const s = commentedSession();
    const before = Y.encodeStateAsUpdate(s.sections.get('d1')!);
    const { bytes } = await buildCopy(s, copyComments);
    const back = importDocx(bytes);
    expect(back.comments.map((c) => c.body)).toEqual(['Note one', 'Note two']);
    const json = JSON.stringify(back.sections);
    expect(json).toContain('comment_anchor');
    expect(json).toContain('anchored words');
    expect(json).toContain('bold');
    expect(Y.encodeStateAsUpdate(s.sections.get('d1')!)).toEqual(before);
    const round = importDocx(exportDocx(back));
    expect(round.comments.map((c) => c.body)).toEqual(['Note one', 'Note two']);
    expect(JSON.stringify(round.sections)).toContain('comment_anchor');
    const r = await saveCopy(s, { save: async () => 'D:\\b.docx', build: copyComments });
    expect(r).toEqual({ status: 'saved', path: 'D:\\b.docx' });
  });
});

describe('saveCopy', () => {
  it('reports busy, not a failure, when the backend lock is held (#100)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveCopy(session(), {
      save: async () => Promise.reject('busy'),
      build: noComments,
    });
    expect(r).toEqual({ status: 'busy' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('sends only the title and bytes; the backend picks the path', async () => {
    const save = vi.fn<(title: string, bytes: Uint8Array) => Promise<string | null>>(
      async () => 'D:\\Copies\\book.docx',
    );
    const r = await saveCopy(session(), { save, build: noComments });
    expect(r).toEqual({ status: 'saved', path: 'D:\\Copies\\book.docx' });
    expect(save).toHaveBeenCalledTimes(1);
    const [title, bytes] = save.mock.calls[0]!;
    expect(title).toBe('Sample Book');
    expect(JSON.stringify(importDocx(bytes).sections)).toContain('Unsaved words in memory');
  });

  it('reports cancelled when the dialog is cancelled', async () => {
    expect(await saveCopy(session(), { save: async () => null, build: noComments })).toEqual({
      status: 'cancelled',
    });
  });

  it('maps a write failure to plain copy, never raw text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveCopy(session(), {
      save: async () => {
        throw 'io: There is not enough space on the disk. (os error 112) C:\\secret\\path';
      },
      build: noComments,
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
