import { describe, expect, it } from 'vitest';
import type { DocNode } from '@coauthor/schema';
import { buildThreads, commentAuthorColor, listCommentAnchors, type CommentRow } from './comments';

const anchor = (id: string) => ({ type: 'comment_anchor' as const, attrs: { id } });
// Synthetic text only.
const doc: DocNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'The ' },
        { type: 'text', text: 'old', marks: [anchor('c1')] },
        { type: 'text', text: ' lamp', marks: [anchor('c1'), { type: 'italic' }] },
        { type: 'text', text: ' hummed', marks: [anchor('c2')] },
      ],
    },
    { type: 'scene_break', attrs: { marker: '***' } },
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'Rain', marks: [anchor('c3')] }],
    },
  ],
};
const row = (
  id: string,
  threadId: string,
  createdAt: string,
  extra: Partial<CommentRow> = {},
): CommentRow => ({
  id,
  threadId,
  body: `body ${id}`,
  authorKind: 'agent',
  authorId: 'a1',
  authorName: 'Bot A',
  createdAt,
  ...extra,
});

describe('comments', () => {
  it('collects anchors by attrs id in reading order across marks', () => {
    expect(listCommentAnchors(doc)).toEqual([
      { id: 'c1', text: 'old lamp' },
      { id: 'c2', text: ' hummed' },
      { id: 'c3', text: 'Rain' },
    ]);
  });
  it('builds threads with sorted replies, resolution and orphans', () => {
    const rows = [
      row('r2', 'c1', '2026-10-25T02:00:00Z', { authorKind: 'human', authorName: 'Me' }),
      row('r1', 'c1', '2026-10-25T01:00:00Z'),
      row('r3', 'c2', '2026-10-25T01:00:00Z', { resolvedAt: '2026-10-25T03:00:00Z' }),
      row('r4', 'gone', '2026-10-25T01:00:00Z', { quote: 'deleted words' }),
    ];
    const t = buildThreads(doc, rows);
    expect(t.map((x) => [x.id, x.order, x.resolved, x.orphan])).toEqual([
      ['c1', 0, false, 'none'],
      ['c2', 1, true, 'none'],
      ['c3', 2, false, 'no_comments'],
      ['gone', -1, false, 'no_anchor'],
    ]);
    expect(t[0]!.comments.map((c) => c.id)).toEqual(['r1', 'r2']);
    expect(t[3]!.anchorText).toBe('deleted words');
  });
  it('anchor survives surrounding text edits (same id, new text around it)', () => {
    const edited: DocNode = JSON.parse(JSON.stringify(doc));
    const p = edited.content[0] as { content: { text: string }[] };
    p.content[0]!.text = 'Once, the ';
    expect(buildThreads(edited, [row('r1', 'c1', 't')])[0]).toMatchObject({
      id: 'c1',
      anchorText: 'old lamp',
      orphan: 'none',
    });
  });
  it('color is stable', () => {
    expect(commentAuthorColor('Bot A')).toBe(commentAuthorColor('Bot A'));
  });
});
