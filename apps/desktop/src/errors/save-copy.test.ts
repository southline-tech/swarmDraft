import { describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import * as Y from 'yjs';
import { docToYDoc, importDocx, type DocNode } from '@coauthor/docx';
import type { Section } from '@coauthor/schema';
import { manuscriptDocx, saveCopy } from './save-copy';

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

describe('saveCopy', () => {
  it('writes the .docx to the picked path', async () => {
    const write = vi.fn<(dest: string, bytes: Uint8Array) => Promise<void>>(async () => {});
    const r = await saveCopy(session(), { pick: async () => 'D:\\Copies\\book.docx', write });
    expect(r).toEqual({ status: 'saved', path: 'D:\\Copies\\book.docx' });
    expect(write).toHaveBeenCalledTimes(1);
    const [dest, bytes] = write.mock.calls[0]!;
    expect(dest).toBe('D:\\Copies\\book.docx');
    expect(JSON.stringify(importDocx(bytes).sections)).toContain('Unsaved words in memory');
  });

  it('does nothing when the dialog is cancelled', async () => {
    const write = vi.fn(async () => {});
    expect(await saveCopy(session(), { pick: async () => null, write })).toEqual({
      status: 'cancelled',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('maps a write failure to plain copy, never raw text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveCopy(session(), {
      pick: async () => 'D:\\Copies\\book.docx',
      write: async () => {
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
