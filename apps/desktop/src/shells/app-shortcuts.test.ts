import { describe, expect, it, vi } from 'vitest';
import { REVIEW_SHORTCUTS } from '../review/review-state';
import { SHORTCUTS } from '../toolbar/toolbar';
import {
  MANUSCRIPT_SHORTCUTS,
  SHORTCUT_SHEET_GROUPS,
  ariaKeyshortcuts,
  menuShortcutLabel,
  shortcutParts,
} from './app-shortcuts';

describe('app shortcuts (#56)', () => {
  it('merges toolbar, review, and manuscript chords into sheet groups', () => {
    const chords = SHORTCUT_SHEET_GROUPS.flatMap((g) => g.rows.map((r) => r.chord));
    expect(chords).toContain(SHORTCUTS.bold);
    expect(chords).toContain(REVIEW_SHORTCUTS.accept);
    expect(chords).toContain(MANUSCRIPT_SHORTCUTS.find);
    expect(chords).toContain(MANUSCRIPT_SHORTCUTS.replace);
    expect(chords).toContain(MANUSCRIPT_SHORTCUTS.shortcutsSheet);
    const labels = SHORTCUT_SHEET_GROUPS.flatMap((g) => g.rows.map((r) => r.label));
    expect(labels).not.toContain('Save now');
    expect(labels.some((l) => l.startsWith('Zoom'))).toBe(false);
  });

  it('formats display keys for the sheet', () => {
    expect(shortcutParts('Ctrl+B')).toEqual(['Ctrl', 'B']);
    expect(shortcutParts(REVIEW_SHORTCUTS.reject)).toEqual(['Ctrl', 'Shift', '⌫']);
    expect(shortcutParts(REVIEW_SHORTCUTS.next)).toEqual(['Alt', 'Shift', '→']);
    expect(shortcutParts('Esc')).toEqual(['Esc']);
  });

  it('formats menu shortcut labels for Mac chapter split', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(menuShortcutLabel('Ctrl+Shift+Enter')).toBe('⌘⇧↩');
    vi.unstubAllGlobals();
  });

  it('maps chords to aria-keyshortcuts', () => {
    expect(ariaKeyshortcuts(MANUSCRIPT_SHORTCUTS.shortcutsSheet)).toBe('Control+/');
    expect(ariaKeyshortcuts(MANUSCRIPT_SHORTCUTS.focusMode)).toBe('Control+Shift+F');
  });
});
