import type { DraftHistoryCompare } from '../backend';
import { formatHistoryLongWhen } from './history-time';

export interface HistoryCompareView {
  entryId: string;
  label: string;
  banner: string;
  wordCountThen: number;
  wordCountNow: number;
  chapters: DraftHistoryCompare['chapters'];
}

export function historyCompareBanner(compare: DraftHistoryCompare, entryLabel: string): string {
  const when = formatHistoryLongWhen(compare.timeUnix);
  return `Comparing with ${entryLabel}, ${when}. Read only. Underlined text is new since then, struck text was removed.`;
}

export function buildCompareView(
  entryId: string,
  entryLabel: string,
  data: DraftHistoryCompare,
): HistoryCompareView {
  return {
    entryId,
    label: entryLabel,
    banner: historyCompareBanner(data, entryLabel),
    wordCountThen: data.wordCountThen,
    wordCountNow: data.wordCountNow,
    chapters: data.chapters,
  };
}
