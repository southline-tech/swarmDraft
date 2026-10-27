/**
 * "Save a copy" from the save-failure banner (#62, mockup ob9).
 *
 * Builds a .docx from the manuscript as it is in memory right now, so edits the database has
 * not taken yet are in the copy, and writes it where the user picks. Nothing in the session or
 * its Y.Docs is changed, and the app's own storage is never the target.
 */
import { exportDocx, yDocToDoc, type ImportedManuscript } from '@coauthor/docx';
import { pickCopyDestination, saveManuscriptCopy } from '../backend';
import type { ManuscriptSession } from '../manuscript-session';
import { mapError, type MappedError } from './map-error';

/** The in-memory manuscript as a .docx (read-only: no Y.Doc is written to). */
export function manuscriptDocx(
  session: Pick<ManuscriptSession, 'title' | 'outline' | 'sections'>,
): Uint8Array {
  const sections = session.outline.value.map((s) => {
    const doc = session.sections.get(s.docId);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      parentId: s.parentId,
      docId: s.docId,
      content: doc ? yDocToDoc(doc) : { type: 'doc' as const, content: [] },
    };
  });
  const m = {
    title: session.title,
    sections,
    comments: [],
    report: { items: [], summary: {} },
    warnings: [],
  } as unknown as ImportedManuscript;
  return exportDocx(m);
}

export type SaveCopyResult =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: MappedError };

export interface SaveCopyDeps {
  pick: (title: string) => Promise<string | null>;
  write: (dest: string, bytes: Uint8Array) => Promise<void>;
}

const defaultDeps: SaveCopyDeps = { pick: pickCopyDestination, write: saveManuscriptCopy };

export async function saveCopy(
  session: Pick<ManuscriptSession, 'title' | 'outline' | 'sections'>,
  deps: SaveCopyDeps = defaultDeps,
): Promise<SaveCopyResult> {
  try {
    const dest = await deps.pick(session.title);
    if (!dest) return { status: 'cancelled' };
    await deps.write(dest, manuscriptDocx(session));
    return { status: 'saved', path: dest };
  } catch (err) {
    console.error('Save a copy failed', err);
    return { status: 'failed', error: mapError(err, 'save') };
  }
}
