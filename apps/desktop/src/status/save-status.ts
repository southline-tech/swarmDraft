import { footerSave } from '../copy-deck';

const UNSAVED_LABEL = footerSave.unsavedLabel;

export const FOOTER_SAVE_ERROR_LABEL = footerSave.errorLabel;

export type ManuscriptSaveView =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'unsaved' }
  | { phase: 'error'; message: string }
  | { phase: 'saved'; savedAt: number };

export function formatSavedAt(savedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (sec < 60) return 'Saved just now';
  const min = Math.floor(sec / 60);
  return `Saved ${min} min ago`;
}

export function saveStatusLabel(view: ManuscriptSaveView, now = Date.now()): string {
  switch (view.phase) {
    case 'idle':
      return '';
    case 'saving':
      return 'Saving…';
    case 'unsaved':
      return UNSAVED_LABEL;
    case 'error':
      return FOOTER_SAVE_ERROR_LABEL;
    case 'saved':
      return formatSavedAt(view.savedAt, now);
  }
}
