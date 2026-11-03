/** Story notes bottom sheet height (#277), persisted locally. */
export const STORY_NOTES_SHEET_HEIGHT_KEY = 'swarmdraft.storyNotesSheetHeight';

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined;

export function loadStoryNotesSheetHeight(storage: Store = globalThis.localStorage): number | null {
  try {
    const raw = storage?.getItem(STORY_NOTES_SHEET_HEIGHT_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveStoryNotesSheetHeight(
  px: number,
  storage: Store = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORY_NOTES_SHEET_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // Storage unavailable: height still applies for this session.
  }
}
