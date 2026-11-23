/**
 * Map Tauri history IPC payloads to UI DTOs (#365, #379).
 *
 * `HistoryFeedEntry` is a serde enum. `rename_all = "camelCase"` renames variants,
 * not variant fields, so those fields arrive as snake_case (`time_unix`,
 * `chapter_title`). Wrapper structs and nested suggestion structs stay camelCase.
 */

import type {
  DraftHistoryCompare,
  DraftHistoryFeed,
  DraftHistoryRestorePreview,
  DraftMilestoneRow,
  HistoryFeedRow,
  HistoryFilterOption,
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
      time_unix: number;
      word_count: number;
      save_state: string;
      reason: string;
    }
  | {
      kind: 'bot';
      oid: string;
      time_unix: number;
      display_time_unix: number;
      agent_id: string;
      agent_name: string;
      summary: string;
      suggestion_count: number;
      suggestions: RawBotSuggestion[];
    }
  | {
      kind: 'authorEdit';
      oid: string;
      time_unix: number;
      chapter_title: string;
      collapsed_count: number;
    }
  | { kind: 'save'; oid: string; time_unix: number }
  | { kind: 'restore'; oid: string; time_unix: number; source_label: string }
  | { kind: 'milestone'; oid: string; time_unix: number; name: string; message: string };

/** Read a serde enum field. Snake_case is what the enum emits; camelCase is accepted too. */
function field(entry: object, snake: string, camel: string): unknown {
  const rec = entry as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, snake)) return rec[snake];
  if (Object.prototype.hasOwnProperty.call(rec, camel)) return rec[camel];
  return undefined;
}

function fieldString(entry: object, snake: string, camel: string): string {
  const value = field(entry, snake, camel);
  return typeof value === 'string' ? value : '';
}

function fieldNumber(entry: object, snake: string, camel: string): number | undefined {
  const value = field(entry, snake, camel);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
  const timeUnix = fieldNumber(entry, 'time_unix', 'timeUnix') ?? Number.NaN;
  switch (entry.kind) {
    case 'current':
      return {
        id: 'current',
        oid: entry.oid,
        kind: 'current',
        actorName: authorLabel,
        isBot: false,
        timeUnix,
        summaryTitle: 'Your book as it is now',
        disabledReason: typeof entry.reason === 'string' ? entry.reason : '',
        currentWordCount: fieldNumber(entry, 'word_count', 'wordCount') ?? null,
      };
    case 'bot': {
      const display = fieldNumber(entry, 'display_time_unix', 'displayTimeUnix');
      const shown = display ?? timeUnix;
      const suggestions = Array.isArray(entry.suggestions) ? entry.suggestions : [];
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'bot',
        actorName: fieldString(entry, 'agent_name', 'agentName') || 'Bot',
        isBot: true,
        agentId: fieldString(entry, 'agent_id', 'agentId'),
        timeUnix: shown,
        summaryTitle: fieldString(entry, 'summary', 'summary'),
        suggestionCount: fieldNumber(entry, 'suggestion_count', 'suggestionCount') ?? null,
        children: mapBotChildren(suggestions, shown),
      };
    }
    case 'authorEdit': {
      const chapterTitle = fieldString(entry, 'chapter_title', 'chapterTitle').trim();
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'authorEdit',
        actorName: 'You',
        isBot: false,
        timeUnix,
        chapterTitle,
        summaryTitle: chapterTitle ? `You edited ${chapterTitle}` : 'You edited a chapter',
      };
    }
    case 'save':
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'save',
        actorName: authorLabel,
        isBot: false,
        timeUnix,
        summaryTitle: 'You saved your book',
      };
    case 'restore': {
      const source = fieldString(entry, 'source_label', 'sourceLabel');
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'restore',
        actorName: authorLabel,
        isBot: false,
        timeUnix,
        summaryTitle: source ? `Restored version from ${source}` : 'Restored version',
      };
    }
    case 'milestone': {
      const name = fieldString(entry, 'name', 'name');
      return {
        id: entry.oid,
        oid: entry.oid,
        kind: 'milestone',
        actorName: authorLabel,
        isBot: false,
        timeUnix,
        milestoneName: name,
        summaryTitle: name,
      };
    }
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
