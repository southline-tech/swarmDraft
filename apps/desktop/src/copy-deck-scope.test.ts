/**
 * Key writer surfaces must import copy-deck.ts (#34). Additional Vue migration continues file-by-file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(process.cwd(), 'src');

const MUST_IMPORT = [
  'HomeScreen.vue',
  'App.vue',
  'export/ExportSection.vue',
  'toolbar/ToolbarExportMenu.vue',
  'updater/UpdatePromptToast.vue',
  'shells/OpeningProgress.vue',
  'review/ReviewPanel.vue',
  'comments/CommentsPanel.vue',
  'notes/StoryNotesPanel.vue',
  'PairingPrompt.vue',
];

describe('copy-deck wiring (#34)', () => {
  it('imports copy-deck in primary writer Vue entrypoints', () => {
    for (const rel of MUST_IMPORT) {
      const text = readFileSync(join(srcRoot, rel), 'utf8');
      expect(text, rel).toMatch(/from ['"][^'"]*copy-deck['"]/);
    }
  });

  it('exports home and error copy from copy-deck.ts', () => {
    const deck = readFileSync(join(srcRoot, 'copy-deck.ts'), 'utf8');
    expect(deck).toContain('export const home');
    expect(deck).toContain('errorCopyBlocks');
  });
});
