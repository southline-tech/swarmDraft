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

/** Strip Win32 verbatim prefixes before showing a path in the UI (#183). */
export function displayUserPath(path: string): string {
  const s = path.replace(/\//g, '\\');
  const uncPrefix = '\\\\?\\UNC\\';
  if (
    s.length >= uncPrefix.length &&
    s.slice(0, uncPrefix.length).toLowerCase() === uncPrefix.toLowerCase()
  ) {
    return `\\\\${s.slice(uncPrefix.length)}`;
  }
  if (s.startsWith('\\\\?\\') || s.startsWith('\\\\.\\')) return s.slice(4);
  return s;
}

export interface BuildCopyDeps {
  loadComments: (manuscriptId: string) => Promise<ManuscriptCopyComment[]>;
}

const defaultBuildDeps: BuildCopyDeps = { loadComments: manuscriptOpenComments };

/** Drop `comment_anchor` marks whose id is not in `keep` (resolved / orphan threads). */
function stripCommentAnchors(node: unknown, keep: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => stripCommentAnchors(n, keep));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'marks' && Array.isArray(v)) {
      const kept = v.filter((m: { type?: string; attrs?: { id?: unknown } }) => {
        if (m?.type !== 'comment_anchor') return true;
        const id = String(m.attrs?.id);
        return keep.has(id);
      });
      if (kept.length) out[k] = kept.map((m) => stripCommentAnchors(m, keep));
    } else out[k] = stripCommentAnchors(v, keep);
  }
  return out;
}

/** One Word comment per thread (anchor id); replies are folded into the root body. */
export function commentsForExport(rows: ManuscriptCopyComment[]): ImportedComment[] {
  const groups = new Map<string, ManuscriptCopyComment[]>();
  for (const r of rows) {
    const g = groups.get(r.threadId) ?? [];
    g.push(r);
    groups.set(r.threadId, g);
  }
  const out: ImportedComment[] = [];
  for (const [anchorId, group] of groups) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const parts = group.map((r) => r.body.trim()).filter(Boolean);
    if (!parts.length) continue;
    const first = group[0]!;
    out.push({
      id: anchorId,
      sectionId: first.sectionId,
      author: first.authorName,
      date: first.createdAt,
      body: parts.join('\n\n'),
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
  let rows: ManuscriptCopyComment[] = [];
  let commentsUnavailable = false;
  if (session.id) {
    try {
      rows = await deps.loadComments(session.id);
    } catch (err) {
      commentsUnavailable = true;
      console.error('Save a copy: could not load comments; exporting without them', err);
    }
  }
  const comments = commentsUnavailable ? [] : commentsForExport(rows);
  const keepAnchors = new Set(comments.map((c) => c.id));

  const sections = session.outline.value.map((s) => {
    const doc = session.sections.get(s.docId);
    const raw = doc ? yDocToDoc(doc) : { type: 'doc' as const, content: [] };
    const content = stripCommentAnchors(raw, keepAnchors);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      parentId: s.parentId,
      docId: s.docId,
      content,
    };
  });
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
    return { status: 'saved', path: displayUserPath(path) };
  } catch (err) {
    if (err === BUSY_CODE) return { status: 'busy' };
    console.error('Save a copy failed', err);
    return { status: 'failed', error: mapError(err, 'save') };
  }
}
