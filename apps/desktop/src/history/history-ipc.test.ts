import { describe, expect, it } from 'vitest';
import {
  mapHistoryCompare,
  mapHistoryFeed,
  mapMilestoneTags,
  mapRestorePreview,
  type RawHistoryCompareResponse,
  type RawHistoryFeedResponse,
} from './history-ipc';
import { formatHistoryDayHeader, formatHistoryRowWhen } from './history-time';

describe('history IPC mappers (#365)', () => {
  it('maps feed entries, filter authors, and current card', () => {
    const raw: RawHistoryFeedResponse = {
      entries: [
        {
          kind: 'current',
          oid: 'head',
          time_unix: 100,
          word_count: 1200,
          save_state: 'saved',
          reason: 'This is your book as it is now.',
        },
        {
          kind: 'bot',
          oid: 'b1',
          time_unix: 90,
          display_time_unix: 80,
          agent_id: 'agent:line',
          agent_name: 'Line Editor',
          summary: 'Tighten opening',
          suggestion_count: 1,
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
    expect(feed.rows[0]!.timeUnix).toBe(80);
    expect(feed.rows[0]!.children?.[0]!.deciderName).toBe('Brett');
    expect(feed.filterOptions[0]!).toMatchObject({ key: 'agent:line', isBot: true });
  });

  it('maps the serde enum shape (snake_case variant fields) to a readable row', () => {
    const unix = 1_700_000_000;
    const raw: RawHistoryFeedResponse = {
      entries: [
        {
          kind: 'current',
          oid: 'head',
          time_unix: unix,
          word_count: 30,
          save_state: 'saved',
          reason: 'This is your book as it is now.',
        },
        {
          kind: 'authorEdit',
          oid: 'e1',
          time_unix: unix,
          chapter_title: 'Chapter Two',
          collapsed_count: 1,
        },
      ],
      filterAuthors: [{ id: 'author', name: 'You', authorKind: 'human', isBot: false }],
      wordCountNow: 30,
      saveState: 'saved',
    };
    const feed = mapHistoryFeed(raw);
    const row = feed.rows[0]!;
    expect(row.summaryTitle).toBe('You edited Chapter Two');
    expect(row.chapterTitle).toBe('Chapter Two');
    expect(row.timeUnix).toBe(unix);
    const when = formatHistoryRowWhen(row.timeUnix, new Date(unix * 1000));
    const header = formatHistoryDayHeader(row.timeUnix, new Date(unix * 1000));
    expect(when).not.toMatch(/Invalid Date|NaN|undefined/);
    expect(header).not.toMatch(/Invalid Date|NaN|undefined/);
    expect(when.length).toBeGreaterThan(0);
    expect(header).toBe('Today');
    expect(feed.rows.map((r) => r.summaryTitle).join(' ')).not.toMatch(/undefined/);
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
    expect(mapped.chapters[0]!.hasChanges).toBe(true);
    expect(mapped.chapters[0]!.segments?.[0]!.kind).toBe('add');

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
