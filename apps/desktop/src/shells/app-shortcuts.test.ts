import { describe, expect, it, vi } from 'vitest';
import { REVIEW_SHORTCUTS } from '../review/review-state';
import { SHORTCUTS } from '../toolbar/toolbar';
import {
  MANUSCRIPT_SHORTCUTS,
  SHORTCUT_SHEET_GROUPS,
  appMenuKeyAction,
  ariaKeyshortcuts,
  displayChord,
  isTrackChangesChord,
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
    expect(chords).toContain(MANUSCRIPT_SHORTCUTS.trackChanges);
    const track = SHORTCUT_SHEET_GROUPS.flatMap((g) => g.rows).find(
      (r) => r.chord === MANUSCRIPT_SHORTCUTS.trackChanges,
    );
    expect(track?.label).toBe('Track changes');
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
    expect(ariaKeyshortcuts(MANUSCRIPT_SHORTCUTS.trackChanges)).toBe('Control+Shift+E');
  });

  it('binds track changes to Ctrl+Shift+E and not neighboring chords', () => {
    const chord = (key: string, extra: KeyboardEventInit = {}) =>
      isTrackChangesChord(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
    expect(MANUSCRIPT_SHORTCUTS.trackChanges).toBe('Ctrl+Shift+E');
    expect(chord('e', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(chord('E', { metaKey: true, shiftKey: true })).toBe(true);
    expect(chord('e', { ctrlKey: true })).toBe(false);
    expect(chord('e', { ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(chord('f', { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(chord('s', { ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it('uses Command on macOS and Control elsewhere (#193)', () => {
    const state = { importing: false, canSave: true, canQuit: true };
    expect(
      appMenuKeyAction(
        { key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        state,
      ),
    ).toBe('save');
    expect(
      appMenuKeyAction(
        { key: 's', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false },
        state,
      ),
    ).toBe(null);
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    try {
      expect(shortcutParts('Ctrl+B')).toEqual(['⌘', 'B']);
      expect(displayChord('Ctrl+Shift+O')).toBe('⌘⇧O');
      expect(menuShortcutLabel('Ctrl+N')).toBe('⌘N');
      expect(ariaKeyshortcuts(SHORTCUTS.bold)).toBe('Meta+B');
      expect(
        appMenuKeyAction(
          { key: 'o', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false },
          state,
        ),
      ).toBe('open');
      expect(
        appMenuKeyAction(
          { key: 'o', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
          state,
        ),
      ).toBe(null);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
