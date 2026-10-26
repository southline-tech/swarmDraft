/**
 * Anchored comment threads (RAD-212, P1: comments only). Threads are built from
 * `comment_anchor` marks in the shared content model joined with comment rows from a
 * `CommentsSource` seam (backed by migration 3's `comments` table once it lands).
 * Anchor ids are always read from mark attrs, never from Yjs mark keys.
 */
import type { DocNode } from '@coauthor/schema';

export type AuthorKind = 'human' | 'agent';

/** Mirrors a migration 3 `comments` row. */
export interface CommentRow {
  id: string;
  threadId: string;
  body: string;
  quote?: string | null;
  blockId?: string | null;
  authorKind: AuthorKind;
  authorId: string;
  authorName: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface CommentThread {
  /** Anchor id (the `comment_anchor` mark's `attrs.id`) == thread id. */
  id: string;
  /** Text currently covered by the anchor, '' if the anchor is gone. */
  anchorText: string;
  /** Position of the anchor in reading order, or -1 when the anchor is missing. */
  order: number;
  comments: CommentRow[];
  resolved: boolean;
  /** Anchor in the doc but no comment rows, or rows whose anchor no longer exists. */
  orphan: 'none' | 'no_comments' | 'no_anchor';
}

export interface NewComment {
  threadId: string;
  body: string;
}

export interface CommentsSource {
  list(): Promise<CommentRow[]>;
  reply(input: NewComment): Promise<CommentRow>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
}

/** Anchor ids with covered text, in reading order. */
export function listCommentAnchors(doc: DocNode): { id: string; text: string }[] {
  const byId = new Map<string, { id: string; text: string }>();
  for (const block of doc.content) {
    if (!('content' in block)) continue;
    for (const node of block.content ?? []) {
      if (node.type !== 'text') continue;
      for (const m of node.marks ?? []) {
        if (m.type !== 'comment_anchor') continue;
        const a = byId.get(m.attrs.id);
        if (a) a.text += node.text;
        else byId.set(m.attrs.id, { id: m.attrs.id, text: node.text });
      }
    }
  }
  return [...byId.values()];
}

export function buildThreads(doc: DocNode, rows: CommentRow[]): CommentThread[] {
  const anchors = listCommentAnchors(doc);
  const rowsByThread = new Map<string, CommentRow[]>();
  for (const r of rows) {
    const list = rowsByThread.get(r.threadId) ?? [];
    list.push(r);
    rowsByThread.set(r.threadId, list);
  }
  const sortRows = (l: CommentRow[]) =>
    [...l].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const resolvedOf = (l: CommentRow[]) => l.length > 0 && l.every((r) => !!r.resolvedAt);

  const threads: CommentThread[] = anchors.map((a, order) => {
    const list = sortRows(rowsByThread.get(a.id) ?? []);
    rowsByThread.delete(a.id);
    return {
      id: a.id,
      anchorText: a.text,
      order,
      comments: list,
      resolved: resolvedOf(list),
      orphan: list.length ? 'none' : 'no_comments',
    };
  });
  for (const [id, list] of rowsByThread) {
    const sorted = sortRows(list);
    threads.push({
      id,
      anchorText: sorted[0]?.quote ?? '',
      order: -1,
      comments: sorted,
      resolved: resolvedOf(sorted),
      orphan: 'no_anchor',
    });
  }
  return threads;
}

/** Stable per-author color (same formula as the suggestions panel). */
export function commentAuthorColor(author: string): string {
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}
