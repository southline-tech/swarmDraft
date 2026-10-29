/**
 * Human track changes (#126): while active, a writer's insertions and deletions become
 * suggestion_insert / suggestion_delete marks under their profile name, instead of direct edits.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { REVIEW_EDIT_TOKEN, registerHumanTrack, reviewGuardKey } from './review';
import { isBindingTransaction } from './ysource';

export const humanTrackKey = new PluginKey('coauthorHumanTrack');

function skipHumanTrack(tr: Transaction): boolean {
  if (tr.getMeta(reviewGuardKey) === REVIEW_EDIT_TOKEN) return true;
  if (tr.getMeta(humanTrackKey)) return true;
  if (isBindingTransaction(tr)) return true;
  return false;
}

function newSuggestionId(): string {
  return crypto.randomUUID();
}

function suggestionTs(): string {
  return new Date().toISOString();
}

/**
 * After a direct edit lands, rewrite it into tracked suggestions in the same history step.
 */
export function humanTrackAppendTransaction(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  author: string,
): Transaction | null {
  const src = transactions.find((t) => t.docChanged && !skipHumanTrack(t));
  if (!src || !author.trim()) return null;

  let tr = newState.tr;
  for (let i = 0; i < src.steps.length; i++) {
    const step = src.steps[i]!;
    if (!(step instanceof ReplaceStep)) continue;
    const beforeDoc = src.docs[i] ?? oldState.doc;
    const from = step.from;
    const to = step.to;
    const deletedText = beforeDoc.textBetween(from, to, '', '');
    const insertedText = step.slice.content.textBetween(0, step.slice.content.size, '', '');
    if (!deletedText && !insertedText) continue;

    const id = newSuggestionId();
    const attrs = { id, author: author.trim(), ts: suggestionTs() };
    const insMark = newState.schema.marks.suggestion_insert!.create(attrs);
    const delMark = newState.schema.marks.suggestion_delete!.create(attrs);
    const mapFrom = tr.mapping.map(from);

    if (deletedText && !insertedText) {
      tr = tr.insert(mapFrom, newState.schema.text(deletedText, [delMark]));
    } else if (!deletedText && insertedText) {
      const start = mapFrom;
      tr = tr.addMark(start, start + insertedText.length, insMark);
    } else {
      tr = tr.insert(mapFrom, newState.schema.text(deletedText, [delMark]));
      const insStart = mapFrom + deletedText.length;
      tr = tr.addMark(insStart, insStart + insertedText.length, insMark);
    }
  }

  if (!tr.docChanged) return null;
  tr.setMeta(humanTrackKey, true);
  tr.setMeta(reviewGuardKey, REVIEW_EDIT_TOKEN);
  return tr;
}

export const HumanTrackChanges = Extension.create({
  name: 'humanTrackChanges',
  addOptions: () => ({
    active: (): boolean => false,
    author: (): string => '',
  }),
  onCreate() {
    this.storage.unregister = registerHumanTrack(this.options.active, this.options.author);
  },
  onDestroy() {
    (this.storage as { unregister?: () => void }).unregister?.();
  },
  addStorage: () => ({ unregister: undefined as (() => void) | undefined }),
  addProseMirrorPlugins() {
    const active = () => this.options.active();
    const author = () => this.options.author();
    return [
      new Plugin({
        key: humanTrackKey,
        appendTransaction: (transactions, oldState, newState) => {
          if (!active()) return null;
          return humanTrackAppendTransaction(transactions, oldState, newState, author());
        },
      }),
    ];
  },
});
