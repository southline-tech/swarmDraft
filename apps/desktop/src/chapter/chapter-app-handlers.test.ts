import { describe, expect, it, vi } from 'vitest';
import { chapterToastUndoHint } from './chapter-app-handlers';

describe('chapter toast (#304)', () => {
  it('shows platform undo hint when toast undo is blocked', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(chapterToastUndoHint()).toBe('Text changed — use Ctrl+Z');
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(chapterToastUndoHint()).toBe('Text changed — use ⌘Z');
    vi.unstubAllGlobals();
  });
});
