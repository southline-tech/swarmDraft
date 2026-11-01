import type { SuggestionItem } from '@swarmdraft/editor';
import type { ReviewChange } from './review-state';
import { groupChanges } from './review-state';

/** Separates section id from the review change key in book-wide lists. */
export const BOOK_SCOPE = '\u0002';

export function scopeBookChangeKey(sectionId: string, changeKey: string): string {
  return `${sectionId}${BOOK_SCOPE}${changeKey}`;
}

export function parseBookChangeKey(
  scoped: string,
): { sectionId: string; changeKey: string } | null {
  const i = scoped.indexOf(BOOK_SCOPE);
  if (i <= 0) return null;
  return { sectionId: scoped.slice(0, i), changeKey: scoped.slice(i + BOOK_SCOPE.length) };
}

export interface BookChapterGroup {
  sectionId: string;
  label: string;
  changeKeys: string[];
}

export function bookChangesFromSections(
  orderedSectionIds: readonly string[],
  itemsBySection: ReadonlyMap<string, readonly SuggestionItem[]>,
): ReviewChange[] {
  const out: ReviewChange[] = [];
  for (const sectionId of orderedSectionIds) {
    const items = itemsBySection.get(sectionId);
    if (!items?.length) continue;
    for (const c of groupChanges(items)) {
      out.push({ ...c, key: scopeBookChangeKey(sectionId, c.key) });
    }
  }
  return out;
}

export function bookChapterGroups(
  orderedSectionIds: readonly string[],
  changes: readonly ReviewChange[],
  labelOf: (sectionId: string) => string,
): BookChapterGroup[] {
  const bySection = new Map<string, string[]>();
  for (const c of changes) {
    const parsed = parseBookChangeKey(c.key);
    if (!parsed) continue;
    const list = bySection.get(parsed.sectionId) ?? [];
    list.push(c.key);
    bySection.set(parsed.sectionId, list);
  }
  const groups: BookChapterGroup[] = [];
  for (const sectionId of orderedSectionIds) {
    const changeKeys = bySection.get(sectionId);
    if (!changeKeys?.length) continue;
    groups.push({ sectionId, label: labelOf(sectionId), changeKeys });
  }
  return groups;
}

export function openChangeCountsBySection(
  orderedSectionIds: readonly string[],
  itemsBySection: ReadonlyMap<string, readonly SuggestionItem[]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sectionId of orderedSectionIds) {
    const items = itemsBySection.get(sectionId);
    if (!items?.length) continue;
    const n = groupChanges(items).length;
    if (n > 0) out[sectionId] = n;
  }
  return out;
}
