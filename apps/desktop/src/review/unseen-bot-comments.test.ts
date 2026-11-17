import { describe, expect, it } from 'vitest';
import type { CommentRow } from '@swarmdraft/editor';
import {
  botCommentThreadIds,
  unseenBotCommentCount,
  useUnseenBotComments,
} from './unseen-bot-comments';

const row = (
  over: Partial<CommentRow> & Pick<CommentRow, 'threadId' | 'authorKind'>,
): CommentRow => ({
  id: over.id ?? 'r1',
  threadId: over.threadId,
  body: over.body ?? 'Note',
  authorKind: over.authorKind,
  authorId: over.authorId ?? 'a1',
  authorName: over.authorName ?? 'Agent',
  createdAt: over.createdAt ?? '2026-01-01T00:00:00Z',
  resolvedAt: over.resolvedAt ?? null,
  ...over,
});

describe('unseen bot comments (#339)', () => {
  it('counts only open agent threads, not human-only or resolved', () => {
    const rows = [
      row({ threadId: 't-bot', authorKind: 'agent' }),
      row({ id: 'r2', threadId: 't-bot', authorKind: 'agent' }),
      row({ id: 'r3', threadId: 't-human', authorKind: 'human' }),
      row({
        id: 'r4',
        threadId: 't-done',
        authorKind: 'agent',
        resolvedAt: '2026-02-01T00:00:00Z',
      }),
    ];
    expect(botCommentThreadIds(rows).sort()).toEqual(['t-bot']);
    expect(unseenBotCommentCount(new Set(['t-bot', 't-human']), new Set())).toBe(2);
    expect(unseenBotCommentCount(new Set(['t-bot']), new Set(['t-bot']))).toBe(0);
  });

  it('tracks session seen threads via the composable', () => {
    const { unseenCount, ingestRows, markThreadSeen, reset } = useUnseenBotComments();
    ingestRows([row({ threadId: 'c1', authorKind: 'agent' })]);
    expect(unseenCount.value).toBe(1);
    ingestRows([row({ threadId: 'c2', authorKind: 'agent', id: 'x' })]);
    expect(unseenCount.value).toBe(2);
    markThreadSeen('c1');
    expect(unseenCount.value).toBe(1);
    ingestRows([row({ threadId: 'h1', authorKind: 'human' })]);
    expect(unseenCount.value).toBe(1);
    reset();
    expect(unseenCount.value).toBe(0);
  });
});
