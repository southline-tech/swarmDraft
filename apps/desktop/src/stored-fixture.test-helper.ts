/** Test helper: a stored manuscript as the backend returns it, from the synthetic fixture. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { docToYDoc, importDocx } from '@coauthor/docx';
import { mockOutlineDisplayTitle } from '../../../fixtures/manuscripts/docx-import/outline-display-titles';
import type { StoredManuscript } from './backend';

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);

export function storedFixture(): StoredManuscript {
  const imported = importDocx(new Uint8Array(readFileSync(fixture)), { manuscriptId: 'x' });
  const dbId = new Map(imported.sections.map((s, i) => [s.id, `sec${i}`]));
  return {
    manuscript: {
      id: 'db-m',
      title: imported.title,
      createdAt: '',
      numberingStyle: 'chapter_arabic',
    },
    sections: imported.sections.map((s, i) => ({
      id: `sec${i}`,
      manuscriptId: 'db-m',
      kind: s.kind,
      parentId: s.parentId ? dbId.get(s.parentId)! : null,
      position: i,
      title: mockOutlineDisplayTitle(s.title),
      docId: `manuscript/db-m/section/sec${i}`,
      state: Array.from(Y.encodeStateAsUpdate(docToYDoc(s.content))),
    })),
  };
}
