/**
 * An open manuscript in the UI: the manuscript Y.Doc (meta + `structure`) and its section docs.
 * The sidebar reads the outline from `structure` and saves edits back to it; changes from any
 * other writer (another window, an agent) show up through the structure observer.
 */
import { shallowRef, type ShallowRef } from 'vue';
import * as Y from 'yjs';
import type { Section } from '@coauthor/schema';
import { normalizeOutline, type OutlineIssue } from '@coauthor/editor';
import {
  importDocx,
  importedToYDocs,
  observeStructure,
  readStructure,
  writeStructure,
  type ImportReport,
} from '@coauthor/docx';

export interface ManuscriptSession {
  id: string;
  title: string;
  manuscript: Y.Doc;
  sections: Map<string, Y.Doc>;
  outline: ShallowRef<Section[]>;
  report: ImportReport;
  /** Problems repaired when the stored outline was opened (already saved back). */
  repairs: OutlineIssue[];
  save(next: Section[]): void;
  close(): void;
}

export function openSession(
  id: string,
  title: string,
  manuscript: Y.Doc,
  sections: Map<string, Y.Doc>,
  report: ImportReport,
): ManuscriptSession {
  // Repair and save back right away, so every id the sidebar shows (e.g. a renamed duplicate)
  // exists in the stored structure and resolves to its doc before the first edit.
  const { sections: repaired, issues: repairs } = normalizeOutline(readStructure(manuscript));
  if (repairs.length) writeStructure(manuscript, repaired);
  const outline = shallowRef(repairs.length ? readStructure(manuscript) : repaired);
  const off = observeStructure(manuscript, (next) => (outline.value = next));
  return {
    id,
    title,
    manuscript,
    sections,
    outline,
    report,
    repairs,
    save: (next) => writeStructure(manuscript, next),
    close: off,
  };
}

/** Import a .docx into a new session. */
export function sessionFromDocx(bytes: Uint8Array, manuscriptId: string): ManuscriptSession {
  const imported = importDocx(bytes, { manuscriptId });
  const docs = importedToYDocs(imported);
  return openSession(manuscriptId, imported.title, docs.manuscript, docs.sections, imported.report);
}
