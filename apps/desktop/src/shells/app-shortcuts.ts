/**
 * Single source for keyboard shortcut chords shown in the wp7 sheet (#56).
 * Toolbar and review maps stay authoritative for what those areas bind; this module merges them
 * with manuscript-level chords and builds the shortcuts sheet groups.
 */
import { SHORTCUTS } from '../toolbar/toolbar';
import { REVIEW_SHORTCUTS } from '../review/review-state';
import { shortcutSheet } from '../copy-deck';
import { isMacPlatform, usesPrimaryModifier } from './modifier-key';

export { isMacPlatform, usesPrimaryModifier };

/** Editor/manuscript shortcuts not covered by {@link SHORTCUTS} or {@link REVIEW_SHORTCUTS}. */
export const MANUSCRIPT_SHORTCUTS = {
  find: 'Ctrl+F',
  replace: 'Ctrl+H',
  shortcutsSheet: 'Ctrl+/',
  focusMode: 'Ctrl+Shift+F',
  focusModeExit: 'Esc',
  save: 'Ctrl+S',
  body: 'Ctrl+Alt+0',
  heading: 'Ctrl+Alt+1',
  blockQuote: 'Ctrl+Alt+2',
  comment: 'Ctrl+Alt+M',
  /** Free of find, focus mode, save, and the review chords. */
  trackChanges: 'Ctrl+Shift+E',
} as const;

/** True for {@link MANUSCRIPT_SHORTCUTS.trackChanges} (Ctrl+Shift+E, or Cmd on Mac). */
export function isTrackChangesChord(ev: KeyboardEvent): boolean {
  const mod = ev.ctrlKey || ev.metaKey;
  return mod && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'e';
}

const KEY_LABELS: Record<string, string> = {
  Backspace: '⌫',
  Right: '→',
  Left: '←',
};

const MAC_KEY_LABELS: Record<string, string> = {
  Ctrl: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↩',
};

/** Split a chord like `Ctrl+Shift+Enter` into display segments for `<kbd>` chips. */
export function shortcutParts(chord: string): string[] {
  const parts = !chord.includes('+')
    ? [KEY_LABELS[chord] ?? chord]
    : chord.split('+').map((part) => KEY_LABELS[part] ?? part);
  if (!isMacPlatform()) return parts;
  return parts.map((part) => MAC_KEY_LABELS[part] ?? part);
}

/** One label for tooltips and menus (`Ctrl+B` or `⌘B`). */
export function displayChord(chord: string): string {
  if (!chord || !isMacPlatform()) return chord;
  return shortcutParts(chord).join('');
}

/** Compact shortcut label for context menus (⌘⇧↩ on Mac). */
export function menuShortcutLabel(chord: string): string {
  return displayChord(chord);
}

/** WAI-ARIA `aria-keyshortcuts` (`Meta` on macOS, `Control` elsewhere). */
export function ariaKeyshortcuts(chord: string): string {
  const mod = isMacPlatform() ? 'Meta' : 'Control';
  return chord.replace(/\bCtrl\b/g, mod);
}

export type AppMenuKeyAction =
  'import-word' | 'save-as' | 'new' | 'open' | 'save' | 'settings' | 'quit';

export type AppMenuKeyState = {
  importing: boolean;
  canSave: boolean;
  canQuit: boolean;
};

type AppMenuKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * Book-menu chord (#104). Command on macOS, Control elsewhere.
 * Returns null when the chord is not one of these actions.
 */
export function appMenuKeyAction(
  e: AppMenuKeyEvent,
  state: AppMenuKeyState,
): AppMenuKeyAction | null {
  if (!usesPrimaryModifier(e)) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey && k === 'o' && !e.altKey) return 'import-word';
  if (e.shiftKey && k === 's' && !e.altKey) return state.canSave ? 'save-as' : null;
  if (e.shiftKey || e.altKey) return null;
  if (k === 'n') return state.importing ? null : 'new';
  if (k === 'o') return 'open';
  if (k === 's') return state.canSave ? 'save' : null;
  if (e.key === ',') return 'settings';
  if (k === 'q') return state.canQuit ? 'quit' : null;
  return null;
}

/** Save or Save As from the editor. Inert in text fields; the caller checks that. */
export function saveChord(e: AppMenuKeyEvent, canSave: boolean): boolean {
  return usesPrimaryModifier(e) && !e.altKey && e.key.toLowerCase() === 's' && canSave;
}

export type ShortcutSheetRow = { label: string; chord: string };
export type ShortcutSheetGroup = { title: string; rows: ShortcutSheetRow[] };

/** Ordered groups for {@link ShortcutsSheet.vue} (wp7). */
export const SHORTCUT_SHEET_GROUPS: ShortcutSheetGroup[] = [
  {
    title: shortcutSheet.formatting,
    rows: [
      { label: shortcutSheet.bold, chord: SHORTCUTS.bold },
      { label: shortcutSheet.italic, chord: SHORTCUTS.italic },
      { label: shortcutSheet.underline, chord: SHORTCUTS.underline },
      { label: shortcutSheet.heading, chord: MANUSCRIPT_SHORTCUTS.heading },
      { label: shortcutSheet.blockQuote, chord: MANUSCRIPT_SHORTCUTS.blockQuote },
      { label: shortcutSheet.bodyText, chord: MANUSCRIPT_SHORTCUTS.body },
    ],
  },
  {
    title: shortcutSheet.editing,
    rows: [
      { label: shortcutSheet.undo, chord: SHORTCUTS.undo },
      { label: shortcutSheet.redo, chord: SHORTCUTS.redo },
      { label: shortcutSheet.find, chord: MANUSCRIPT_SHORTCUTS.find },
      { label: shortcutSheet.replace, chord: MANUSCRIPT_SHORTCUTS.replace },
      { label: shortcutSheet.addComment, chord: MANUSCRIPT_SHORTCUTS.comment },
    ],
  },
  {
    title: shortcutSheet.review,
    rows: [
      { label: shortcutSheet.trackChanges, chord: MANUSCRIPT_SHORTCUTS.trackChanges },
      { label: shortcutSheet.nextChange, chord: REVIEW_SHORTCUTS.next },
      { label: shortcutSheet.previousChange, chord: REVIEW_SHORTCUTS.prev },
      { label: shortcutSheet.acceptChange, chord: REVIEW_SHORTCUTS.accept },
      { label: shortcutSheet.rejectChange, chord: REVIEW_SHORTCUTS.reject },
    ],
  },
  {
    title: shortcutSheet.view,
    rows: [
      { label: shortcutSheet.shortcutsSheet, chord: MANUSCRIPT_SHORTCUTS.shortcutsSheet },
      { label: shortcutSheet.focusMode, chord: MANUSCRIPT_SHORTCUTS.focusMode },
      { label: shortcutSheet.exitFocusMode, chord: MANUSCRIPT_SHORTCUTS.focusModeExit },
      { label: shortcutSheet.toggleSidebars, chord: REVIEW_SHORTCUTS.toggle },
    ],
  },
];
