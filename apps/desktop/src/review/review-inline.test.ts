import { describe, expect, it } from 'vitest';
import type { CommentThread } from '@swarmdraft/editor';
import {
  buildReviewList,
  commentReviewKey,
  isCommentReviewKey,
  threadIdFromCommentReviewKey,
} from './review-inline';
import type { ReviewChange } from './review-state';

const change = (key: string, author: string, from: number): ReviewChange =>
  ({
    key,
    id: key,
    author,
    ins: 'x',
    targets: [{ kind: 'suggestion_insert', id: key }],
    __from: from,
  }) as ReviewChange & { __from: number };

const thread = (id: string, order: number, extra?: Partial<CommentThread>): CommentThread => ({
  id,
  anchorText: 'quote',
  order,
  comments: [
    {
      id: 'r1',
      threadId: id,
      body: 'Note',
      authorKind: 'human',
      authorId: 'u1',
      authorName: 'Mara',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  resolved: false,
  orphan: 'none',
  ...extra,
});

describe('buildReviewList (#239)', () => {
  it('sorts by anchor from with suggestions before comments at the same from', () => {
    const c1 = change('s1', 'agent:a1', 10);
    const c2 = change('s2', 'agent:a1', 20);
    const list = buildReviewList({
      changes: [c2, c1],
      threads: [thread('c1', 0), thread('c2', 1)],
      filter: null,
      showResolved: false,
      fromOfChange: (c) => (c as ReviewChange & { __from?: number }).__from ?? 0,
      fromOfThread: (t) => (t.order < 0 ? -1 : t.order === 0 ? 10 : 20),
    });
    expect(list.map((i) => i.key)).toEqual([
      's1',
      commentReviewKey('c1'),
      's2',
      commentReviewKey('c2'),
    ]);
  });

  it('keeps comments when author filter hides suggestions', () => {
    const list = buildReviewList({
      changes: [change('s1', 'agent:a1', 0)],
      threads: [thread('c1', 0)],
      filter: 'agent:other',
      showResolved: false,
      fromOfChange: () => 0,
      fromOfThread: () => 5,
    });
    expect(list.every((i) => i.kind === 'comment')).toBe(true);
  });

  it('omits no_comments threads and hides resolved unless showResolved', () => {
    const list = buildReviewList({
      changes: [],
      threads: [
        thread('empty', 0, { orphan: 'no_comments', comments: [] }),
        thread('done', 1, { resolved: true }),
      ],
      filter: null,
      showResolved: false,
      fromOfChange: () => 0,
      fromOfThread: (t) => t.order,
    });
    expect(list).toHaveLength(0);
    const withResolved = buildReviewList({
      changes: [],
      threads: [thread('done', 1, { resolved: true })],
      filter: null,
      showResolved: true,
      fromOfChange: () => 0,
      fromOfThread: (t) => t.order,
    });
    expect(withResolved).toHaveLength(1);
  });

  it('uses comment: scroll-sync keys', () => {
    expect(commentReviewKey('t1')).toBe('comment:t1');
    expect(isCommentReviewKey('comment:t1')).toBe(true);
    expect(threadIdFromCommentReviewKey('comment:t1')).toBe('t1');
  });
});
