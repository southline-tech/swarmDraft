/**
 * "Save a copy" from the save-failure banner (#62, mockup ob9).
 *
 * Builds a .docx from the manuscript as it is in memory right now, so edits the database has
 * not taken yet are in the copy, and the backend writes it where the user picks in a save dialog
 * it opens itself. Nothing in the session or its Y.Docs is changed, and the app's own storage is
 * never the target.
 *
 * Comment bodies are read from the database; anchors come from the in-memory section docs (#74).
 */
import {
  exportDocx,
  yDocToDoc,
  type ImportedComment,
  type ImportedManuscript,
} from '@coauthor/docx';
import { manuscriptOpenComments, saveManuscriptCopy, type ManuscriptCopyComment } from '../backend';
import type { ManuscriptSession } from '../manuscript-session';
import { mapError, type MappedError } from './map-error';
import { BUSY_CODE } from './busy';

export interface BuildCopyDeps {
  loadComments: (manuscriptId: string) => Promise<ManuscriptCopyComment[]>;
}

const defaultBuildDeps: BuildCopyDeps = { loadComments: manuscriptOpenComments };

/** Collect distinct `comment_anchor` ids under a ProseMirror JSON tree. */
function collectAnchorIds(node: unknown, ids: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectAnchorIds(n, ids);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.marks)) {
    for (const m of o.marks) {
      if (
        m &&
        typeof m === 'object' &&
        (m as { type?: string }).type === 'comment_anchor' &&
        (m as { attrs?: { id?: unknown } }).attrs?.id != null
      ) {
        ids.add(String((m as { attrs: { id: unknown } }).attrs.id));
      }
    }
  }
  for (const v of Object.values(o)) collectAnchorIds(v, ids);
}

function commentsForExport(
  rows: ManuscriptCopyComment[],
  anchorIds: Set<string>,
  defaultSectionId: string,
): ImportedComment[] {
  const out: ImportedComment[] = rows.map((r) => ({
    id: r.threadId,
    sectionId: r.sectionId,
    author: r.authorName,
    date: r.createdAt,
    body: r.body,
  }));
  const threadsWithBody = new Set(rows.map((r) => r.threadId));
  for (const id of anchorIds) {
    if (threadsWithBody.has(id)) continue;
    out.push({
      id,
      sectionId: defaultSectionId,
      author: 'Unknown',
      date: '',
      body: '',
    });
  }
  return out;
}

/** The in-memory manuscript as a .docx (read-only: no Y.Doc is written to). */
export async function manuscriptDocx(
  session: Pick<ManuscriptSession, 'id' | 'title' | 'outline' | 'sections'>,
  deps: BuildCopyDeps = defaultBuildDeps,
): Promise<Uint8Array> {
  return (await buildCopy(session, deps)).bytes;
}

/** The copy's bytes from the current in-memory manuscript and stored comment rows. */
export async function buildCopy(
  session: Pick<ManuscriptSession, 'id' | 'title' | 'outline' | 'sections'>,
  deps: BuildCopyDeps = defaultBuildDeps,
): Promise<{ bytes: Uint8Array }> {
  const anchorIds = new Set<string>();
  const sections = session.outline.value.map((s) => {
    const doc = session.sections.get(s.docId);
    const content = doc ? yDocToDoc(doc) : { type: 'doc' as const, content: [] };
    collectAnchorIds(content, anchorIds);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      parentId: s.parentId,
      docId: s.docId,
      content,
    };
  });
  const rows = session.id ? await deps.loadComments(session.id) : [];
  const defaultSectionId = sections[0]?.id ?? '';
  const comments = commentsForExport(rows, anchorIds, defaultSectionId);
  const m = {
    title: session.title,
    sections,
    comments,
    report: { items: [], summary: {} },
    warnings: [],
  } as unknown as ImportedManuscript;
  return { bytes: exportDocx(m) };
}

export type SaveCopyResult =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  /** A backup, restore or another copy holds the shared lock (#100); nothing was written. */
  | { status: 'busy' }
  | { status: 'failed'; error: MappedError };

export interface SaveCopyDeps {
  /** Opens the save dialog in the backend and writes; resolves to the path, or null if cancelled. */
  save: (title: string, bytes: Uint8Array) => Promise<string | null>;
  build: BuildCopyDeps;
}

const defaultDeps: SaveCopyDeps = { save: saveManuscriptCopy, build: defaultBuildDeps };

export async function saveCopy(
  session: Pick<ManuscriptSession, 'id' | 'title' | 'outline' | 'sections'>,
  deps: SaveCopyDeps = defaultDeps,
): Promise<SaveCopyResult> {
  try {
    const { bytes } = await buildCopy(session, deps.build);
    const path = await deps.save(session.title, bytes);
    if (!path) return { status: 'cancelled' };
    return { status: 'saved', path };
  } catch (err) {
    if (err === BUSY_CODE) return { status: 'busy' };
    console.error('Save a copy failed', err);
    return { status: 'failed', error: mapError(err, 'save') };
  }
}
