import { describe, expect, it } from 'vitest';
import {
  mapHistoryCompare,
  mapHistoryFeed,
  mapMilestoneTags,
  mapRestorePreview,
  type RawHistoryCompareResponse,
  type RawHistoryFeedResponse,
} from './history-ipc';

describe('history IPC mappers (#365)', () => {
  it('maps feed entries, filter authors, and current card', () => {
    const raw: RawHistoryFeedResponse = {
      entries: [
        {
          kind: 'current',
          oid: 'head',
          timeUnix: 100,
          wordCount: 1200,
          saveState: 'saved',
          reason: 'This is your book as it is now.',
        },
        {
          kind: 'bot',
          oid: 'b1',
          timeUnix: 90,
          displayTimeUnix: 80,
          agentId: 'agent:line',
          agentName: 'Line Editor',
          summary: 'Tighten opening',
          suggestionCount: 1,
          suggestions: [
            {
              changeId: 'c1',
              status: 'accepted',
              quote: 'Hello',
              decidedBy: 'Brett',
              sectionId: 's1',
              chapterTitle: 'Chapter 1',
            },
          ],
        },
      ],
      filterAuthors: [
        { id: 'author', name: 'Brett', authorKind: 'human', isBot: false },
        { id: 'agent:line', name: 'Line Editor', authorKind: 'agent', isBot: true },
      ],
      wordCountNow: 1200,
      saveState: 'saved',
    };
    const feed = mapHistoryFeed(raw);
    expect(feed.wordCount).toBe(1200);
    expect(feed.current?.kind).toBe('current');
    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0].timeUnix).toBe(80);
    expect(feed.rows[0].children?.[0].deciderName).toBe('Brett');
    expect(feed.filterOptions[0]).toMatchObject({ key: 'agent:line', isBot: true });
  });

  it('maps compare and restore preview payloads', () => {
    const compare: RawHistoryCompareResponse = {
      oid: 'oid1',
      labelName: 'You',
      labelTimeUnix: 200,
      totalWordsThen: 10,
      totalWordsNow: 12,
      sections: [
        {
          sectionId: 'ch1',
          title: 'One',
          added: 2,
          removed: 0,
          segments: [{ segmentKind: 'add', text: 'new' }],
        },
      ],
    };
    const mapped = mapHistoryCompare(compare);
    expect(mapped.wordCountThen).toBe(10);
    expect(mapped.chapters[0].hasChanges).toBe(true);
    expect(mapped.chapters[0].segments?.[0].kind).toBe('add');

    expect(
      mapRestorePreview({
        titleLabel: 'You · Nov 1',
        restoreTimeUnix: 200,
        wordCount: 10,
        pendingReviewCount: 2,
        keptMilestoneName: 'Before restoring · Nov 1',
        isMilestone: false,
      }).pendingReviewCount,
    ).toBe(2);

    expect(
      mapMilestoneTags([{ name: 'Draft', oid: 'x', timeUnix: 1, message: 'Draft' }])[0],
    ).toMatchObject({
      refName: 'Draft',
    });
  });
});
