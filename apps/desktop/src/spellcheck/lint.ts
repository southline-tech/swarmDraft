import type { SpellLintResult } from '@swarmdraft/editor';
import { spellLintParagraph } from '../backend';
import { loadSpellPrefs, spellcheckEnabled } from '../settings/prefs';

export async function lintBlockText(
  manuscriptId: string | undefined,
  text: string,
): Promise<SpellLintResult[]> {
  const prefs = loadSpellPrefs();
  if (!spellcheckEnabled(prefs)) return [];
  try {
    return await spellLintParagraph(manuscriptId, text, prefs.spelling, prefs.grammar);
  } catch {
    return [];
  }
}
