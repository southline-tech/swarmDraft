/** Per-book scroll + section restore in app state, not in the manuscript file (#333). */

export interface ReadingPosition {
  sectionId: string;
  scrollTop: number;
}

const KEY = 'swarmdraft.reading-position.v1';

type Store = Record<string, ReadingPosition>;

function readStore(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode
  }
}

export function loadReadingPosition(manuscriptId: string): ReadingPosition | null {
  const row = readStore()[manuscriptId];
  if (!row || typeof row.sectionId !== 'string') return null;
  if (typeof row.scrollTop !== 'number' || !Number.isFinite(row.scrollTop)) return null;
  return { sectionId: row.sectionId, scrollTop: Math.max(0, row.scrollTop) };
}

export function saveReadingPosition(manuscriptId: string, pos: ReadingPosition): void {
  const store = readStore();
  store[manuscriptId] = {
    sectionId: pos.sectionId,
    scrollTop: Math.max(0, pos.scrollTop),
  };
  writeStore(store);
}

/** If the chapter shrank, land at the bottom instead of past the end. */
export function clampScrollTop(scrollTop: number, maxScroll: number): number {
  const max = Math.max(0, maxScroll);
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return 0;
  return Math.min(scrollTop, max);
}
