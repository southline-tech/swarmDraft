/**
 * Single source for keyboard shortcut chords shown in the wp7 sheet (#56).
 * Toolbar and review maps stay authoritative for what those areas bind; this module merges them
 * with manuscript-level chords and builds the shortcuts sheet groups.
 */
import { SHORTCUTS } from '../toolbar/toolbar';
import { REVIEW_SHORTCUTS } from '../review/review-state';

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
} as const;

const KEY_LABELS: Record<string, string> = {
  Backspace: '⌫',
  Right: '→',
  Left: '←',
};

/** Split a chord like `Ctrl+Shift+Enter` into display segments for `<kbd>` chips. */
export function shortcutParts(chord: string): string[] {
  if (!chord.includes('+')) return [KEY_LABELS[chord] ?? chord];
  return chord.split('+').map((part) => KEY_LABELS[part] ?? part);
}

/** WAI-ARIA `aria-keyshortcuts` form (`Control` not `Ctrl`). */
export function ariaKeyshortcuts(chord: string): string {
  return chord.replace(/\bCtrl\b/g, 'Control');
}

export type ShortcutSheetRow = { label: string; chord: string };
export type ShortcutSheetGroup = { title: string; rows: ShortcutSheetRow[] };

/** Ordered groups for {@link ShortcutsSheet.vue} (wp7). */
export const SHORTCUT_SHEET_GROUPS: ShortcutSheetGroup[] = [
  {
    title: 'Formatting',
    rows: [
      { label: 'Bold', chord: SHORTCUTS.bold },
      { label: 'Italic', chord: SHORTCUTS.italic },
      { label: 'Underline', chord: SHORTCUTS.underline },
      { label: 'Heading', chord: MANUSCRIPT_SHORTCUTS.heading },
      { label: 'Block quote', chord: MANUSCRIPT_SHORTCUTS.blockQuote },
      { label: 'Body text', chord: MANUSCRIPT_SHORTCUTS.body },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { label: 'Undo', chord: SHORTCUTS.undo },
      { label: 'Redo', chord: SHORTCUTS.redo },
      { label: 'Find', chord: MANUSCRIPT_SHORTCUTS.find },
      { label: 'Replace', chord: MANUSCRIPT_SHORTCUTS.replace },
      { label: 'Add comment', chord: MANUSCRIPT_SHORTCUTS.comment },
    ],
  },
  {
    title: 'Review',
    rows: [
      { label: 'Next change', chord: REVIEW_SHORTCUTS.next },
      { label: 'Previous change', chord: REVIEW_SHORTCUTS.prev },
      { label: 'Accept change', chord: REVIEW_SHORTCUTS.accept },
      { label: 'Reject change', chord: REVIEW_SHORTCUTS.reject },
    ],
  },
  {
    title: 'View',
    rows: [
      { label: 'Keyboard shortcuts', chord: MANUSCRIPT_SHORTCUTS.shortcutsSheet },
      { label: 'Focus mode', chord: MANUSCRIPT_SHORTCUTS.focusMode },
      { label: 'Exit focus mode', chord: MANUSCRIPT_SHORTCUTS.focusModeExit },
      { label: 'Toggle sidebars', chord: REVIEW_SHORTCUTS.toggle },
    ],
  },
];
