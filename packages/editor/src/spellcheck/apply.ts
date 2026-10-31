import type { Editor } from '@tiptap/core';
import type { Mark as PMMark } from '@tiptap/pm/model';
import { SUGGESTION_MARKS } from '../content';
import type { SpellIssue } from './types';

const isSuggestion = (m: PMMark) => (SUGGESTION_MARKS as readonly string[]).includes(m.type.name);

/** Replace a flagged range with a suggestion on the normal undo stack. */
export function applySpellSuggestion(
  editor: Editor,
  issue: SpellIssue,
  suggestion: string,
): boolean {
  const { from, to } = issue;
  const marks = editor.state.doc
    .resolve(from)
    .marks()
    .filter((m) => !isSuggestion(m));
  return editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, editor.schema.text(suggestion, marks))
    .run();
}
