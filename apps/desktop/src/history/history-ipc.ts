/** Map Tauri history IPC payloads to UI DTOs (#365). */

import type {
  DraftHistoryCompare,
  DraftHistoryFeed,
  DraftHistoryRestorePreview,
  DraftMilestoneRow,
  HistoryFeedRow,
  HistoryFilterOption,
  HistoryRowKind,
  HistorySuggestionChild,
  HistorySuggestionStatus,
} from '../backend';

interface RawFilterAuthor {
  id: string;
  name: string;
  authorKind: string;
  isBot: boolean;
}

interface RawBotSuggestion {
  changeId: string;
  status: string;
  quote: string;
  decidedBy?: string | null;
  sectionId: string;
  chapterTitle: string;
}

type RawFeedEntry =
  | {
      kind: 'current';
      oid: string;
      timeUnix: number;
      wordCount: number;
      saveState: string;
      reason: string;
    }
  | {
      kind: 'bot';
      oid: string;
      timeUnix: number;
      displayTimeUnix: number;
      agentId: string;
      agentName: string;
      summary: string;
      suggestionCount: number;
      suggestions: RawBotSuggestion[];
    }
  | {
      kind: 'authorEdit';
      oid: string;
      timeUnix: number;
      chapterTitle: string;
      collapsedCount: number;
    }
  | { kind: 'save'; oid: string; timeUnix: number }
  | { kind: 'restore'; oid: string; timeUnix: number; sourceLabel: string }
  | { kind: 'milestone'; oid: string; timeUnix: number; name: string; message: string };

export interface RawHistoryFeedResponse {
  entries: RawFeedEntry[];
  filterAuthors: RawFilterAuthor[];
  wordCountNow: number;
  saveState: string;
}

interface RawCompareSection {
  sectionId: string;
  title: string;
  added: number;
  removed: number;
  segments?: { segmentKind: string; text: string }[] | null;
}

export interface RawHistoryCompareResponse {
  oid: string;
  labelName: string;
  labelTimeUnix: number;
  totalWordsThen: number;
  totalWordsNow: number;
  sections: RawCompareSection[];
}

export interface RawHistoryRestorePreviewResponse {
  titleLabel: string;
  restoreTimeUnix: number;
  wordCount: number;
  pendingReviewCount: number;
  keptMilestoneName: string;
  isMilestone: boolean;
}

export interface RawMilestoneTag {
  name: string;
  oid: string;
  timeUnix: number;
  message: string;
}

function mapSuggestionStatus(raw: string): HistorySuggestionStatus {
  if (raw === 'rejected') return 'rejected';
  if (raw === 'edited_later' || raw === 'editedLater') return 'editedLater';
  return 'accepted';
}

function mapBotChildren(
  suggestions: RawBotSuggestion[],
  parentTime: number,
): HistorySuggestionChild[] {
  return suggestions.map((s) => ({
    changeId: s.changeId,
    status: mapSuggestionStatus(s.status),
    quote: s.quote,
    deciderName: s.decidedBy?.trim() || 'You',
    chapterTitle: s.chapterTitle,
    sectionId: s.sectionId,
    timeUnix: parentTime,
  }));
}

function mapFeedRow(entry: RawFeedEntry, authorLabel: string): HistoryFeedRow | null {
  switch (entry.kind) {
    case 'current':
      return {
        id: 'current',
        oid: entry.oid,
        kind: 'current',
        actorName: authorLabel,
        isBot: false,
        timeUnix: entry.timeUnix,
        summaryTitle: 'Your book as it is now',
        disabledReason: entry.reason,
        currentWordCount: entry.wordCount,
      };
    case 'bot':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'bot',
        actorName: entry.agentName,
        isBot: true,
        agentId: entry.agentId,
        timeUnix: entry.displayTimeUnix,
        summaryTitle: entry.summary,
        suggestionCount: entry.suggestionCount,
        children: mapBotChildren(entry.suggestions, entry.timeUnix),
      };
    case 'authorEdit':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'authorEdit',
        actorName: 'You',
        isBot: false,
        timeUnix: entry.timeUnix,
        chapterTitle: entry.chapterTitle,
        summaryTitle: `You edited ${entry.chapterTitle}`,
      };
    case 'save':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'save',
        actorName: authorLabel,
        isBot: false,
        timeUnix: entry.timeUnix,
        summaryTitle: 'You saved your book',
      };
    case 'restore':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'restore',
        actorName: authorLabel,
        isBot: false,
        timeUnix: entry.timeUnix,
        summaryTitle: `Restored version from ${entry.sourceLabel}`,
      };
    case 'milestone':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'milestone',
        actorName: authorLabel,
        isBot: false,
        timeUnix: entry.timeUnix,
        milestoneName: entry.name,
        summaryTitle: entry.name,
      };
    default:
      return null;
  }
}

export function mapHistoryFeed(raw: RawHistoryFeedResponse): DraftHistoryFeed {
  const author = raw.filterAuthors.find((f) => !f.isBot)?.name?.trim() || 'You';
  const rows: HistoryFeedRow[] = [];
  for (const entry of raw.entries) {
    const row = mapFeedRow(entry, author);
    if (row && row.kind !== 'current') {
      rows.push(row);
    }
  }
  const filterOptions: HistoryFilterOption[] = raw.filterAuthors
    .filter((f) => f.isBot)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ key: f.id, label: f.name, isBot: true }));
  return {
    rows,
    filterOptions,
    authorLabel: author,
    wordCount: raw.wordCountNow,
    current: raw.entries.find((e) => e.kind === 'current')
      ? mapFeedRow(
          raw.entries.find((e) => e.kind === 'current')!,
          author,
        )!
      : undefined,
  };
}

export function mapHistoryCompare(raw: RawHistoryCompareResponse): DraftHistoryCompare {
  return {
    oid: raw.oid,
    timeUnix: raw.labelTimeUnix,
    wordCountThen: raw.totalWordsThen,
    wordCountNow: raw.totalWordsNow,
    chapters: raw.sections.map((s) => ({
      sectionId: s.sectionId,
      title: s.title,
      hasChanges: s.added > 0 || s.removed > 0,
      segments:
        s.segments?.map((seg) => ({
          kind:
            seg.segmentKind === 'add' || seg.segmentKind === 'remove' ? seg.segmentKind : 'same',
          text: seg.text,
        })) ?? undefined,
    })),
  };
}

export function mapRestorePreview(
  raw: RawHistoryRestorePreviewResponse,
): DraftHistoryRestorePreview {
  return {
    titleLabel: raw.titleLabel,
    restoreTimeUnix: raw.restoreTimeUnix,
    wordCount: raw.wordCount,
    pendingReviewCount: raw.pendingReviewCount,
    keptMilestoneName: raw.keptMilestoneName,
    isMilestone: raw.isMilestone,
  };
}

export function mapMilestoneTags(raw: RawMilestoneTag[]): DraftMilestoneRow[] {
  return raw.map((t) => ({
    refName: t.name,
    displayName: t.name,
    timeUnix: t.timeUnix,
    oid: t.oid,
  }));
}
