/**
 * "Save a copy" from the save-failure banner (#62, mockup ob9).
 *
 * Builds a .docx from the manuscript as it is in memory right now, so edits the database has
 * not taken yet are in the copy, and the backend writes it where the user picks in a save dialog
 * it opens itself. Nothing in the session or its Y.Docs is changed, and the app's own storage is
 * never the target.
 *
 * Comment text lives in the database, not in the in-memory docs, so the copy can't carry it.
 * Comment markers are stripped (a marker with no comment entry makes Word repair the file) and
 * the banner says comments were left out.
 */
import { exportDocx, yDocToDoc, type ImportedManuscript } from '@coauthor/docx';
import { saveManuscriptCopy } from '../backend';
import type { ManuscriptSession } from '../manuscript-session';
import { mapError, type MappedError } from './map-error';

/** The in-memory manuscript as a .docx (read-only: no Y.Doc is written to). */
export function manuscriptDocx(
  session: Pick<ManuscriptSession, 'title' | 'outline' | 'sections'>,
): Uint8Array {
  return buildCopy(session).bytes;
}

/** Drop `comment_anchor` marks from any JSON node tree, counting distinct anchors removed. */
function stripCommentMarks(node: unknown, ids: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => stripCommentMarks(n, ids));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'marks' && Array.isArray(v)) {
      const kept = v.filter((m: { type?: string; attrs?: { id?: unknown } }) => {
        if (m?.type !== 'comment_anchor') return true;
        ids.add(String(m.attrs?.id));
        return false;
      });
      if (kept.length) out[k] = kept.map((m) => stripCommentMarks(m, ids));
    } else out[k] = stripCommentMarks(v, ids);
  }
  return out;
}

/** The copy's bytes and how many comment threads had to be left out of it. */
export function buildCopy(session: Pick<ManuscriptSession, 'title' | 'outline' | 'sections'>): {
  bytes: Uint8Array;
  commentsLeftOut: number;
} {
  const ids = new Set<string>();
  const sections = session.outline.value.map((s) => {
    const doc = session.sections.get(s.docId);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      parentId: s.parentId,
      docId: s.docId,
      content: stripCommentMarks(doc ? yDocToDoc(doc) : { type: 'doc' as const, content: [] }, ids),
    };
  });
  const m = {
    title: session.title,
    sections,
    comments: [],
    report: { items: [], summary: {} },
    warnings: [],
  } as unknown as ImportedManuscript;
  return { bytes: exportDocx(m), commentsLeftOut: ids.size };
}

export type SaveCopyResult =
  | { status: 'saved'; path: string; commentsLeftOut: number }
  | { status: 'cancelled' }
  | { status: 'failed'; error: MappedError };

export interface SaveCopyDeps {
  /** Opens the save dialog in the backend and writes; resolves to the path, or null if cancelled. */
  save: (title: string, bytes: Uint8Array) => Promise<string | null>;
}

const defaultDeps: SaveCopyDeps = { save: saveManuscriptCopy };

export async function saveCopy(
  session: Pick<ManuscriptSession, 'title' | 'outline' | 'sections'>,
  deps: SaveCopyDeps = defaultDeps,
): Promise<SaveCopyResult> {
  try {
    const { bytes, commentsLeftOut } = buildCopy(session);
    const path = await deps.save(session.title, bytes);
    if (!path) return { status: 'cancelled' };
    return { status: 'saved', path, commentsLeftOut };
  } catch (err) {
    console.error('Save a copy failed', err);
    return { status: 'failed', error: mapError(err, 'save') };
  }
}
