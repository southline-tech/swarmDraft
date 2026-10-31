/**
 * Manuscript save copy for the status footer (#204, story-notes ap5 / #185).
 * Labels update with time since the last successful persist.
 */

export type ManuscriptSaveView =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; savedAt: number }
  | { phase: 'error'; message: string };

/** Relative "Saved …" line; pass `now` in tests. */
export function formatSavedAt(savedAt: number, now = Date.now()): string {
  const sec = Math.floor((now - savedAt) / 1000);
  if (sec < 60) return 'Saved just now';
  const min = Math.floor(sec / 60);
  return min === 1 ? 'Saved 1 min ago' : `Saved ${min} min ago`;
}

export function saveStatusLabel(view: ManuscriptSaveView, now = Date.now()): string {
  switch (view.phase) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return formatSavedAt(view.savedAt, now);
    case 'error':
      return view.message;
    default:
      return '';
  }
}
