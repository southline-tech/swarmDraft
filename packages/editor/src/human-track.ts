/**
 * Human track changes (#126): while active, a writer's insertions and deletions become
 * suggestion_insert / suggestion_delete marks under their profile name, instead of direct edits.
 */
import { Extension } from '@tiptap/core';
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { humanTrackKey, ownPendingInsertRange, REVIEW_EDIT_TOKEN, reviewGuardKey } from './review';
import { isBindingTransaction } from './ysource';

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

function ownInsertAttrs(
  doc: PMNode,
  pos: number,
  author: string,
): { id: string; author: string; ts: string } | null {
  if (!author.trim()) return null;
  const $pos = doc.resolve(pos);
  const marks = [
    ...($pos.nodeBefore?.marks ?? []),
    ...($pos.nodeAfter?.marks ?? []),
    ...$pos.marks(),
  ];
  for (const m of marks) {
    if (
      m.type.name === 'suggestion_insert' &&
      String(m.attrs.author ?? '').trim() === author.trim()
    ) {
      return {
        id: String(m.attrs.id),
        author: author.trim(),
        ts: String(m.attrs.ts ?? suggestionTs()),
      };
    }
  }
  return null;
}

function isOwnPendingInsertRange(doc: PMNode, from: number, to: number, author: string): boolean {
  return ownPendingInsertRange(doc, from, to, author);
}

function addMarkToFragment(fragment: Fragment, mark: PMMark): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) nodes.push(node.mark(mark.addToSet(node.marks)));
    else if (node.content.size) nodes.push(node.copy(addMarkToFragment(node.content, mark)));
    else nodes.push(node);
  });
  return Fragment.fromArray(nodes);
}

function sliceWithMark(slice: Slice, mark: PMMark): Slice {
  return new Slice(addMarkToFragment(slice.content, mark), slice.openStart, slice.openEnd);
}

function insertSpanLen(beforeDoc: PMNode, step: ReplaceStep, hasDeletion: boolean): number {
  const applied = step.apply(beforeDoc);
  if (applied.failed || !applied.doc) return 0;
  if (!hasDeletion) return applied.doc.content.size - beforeDoc.content.size;
  const net = applied.doc.content.size - beforeDoc.content.size;
  if (net > 0) return net;
  return step.slice.size;
}

function markInsertedSlice(
  tr: Transaction,
  beforeDoc: PMNode,
  step: ReplaceStep,
  mapFrom: number,
  mark: PMMark,
  offset: number,
  hasDeletion: boolean,
): Transaction {
  const insertLen = insertSpanLen(beforeDoc, step, hasDeletion);
  const insFrom = mapFrom + offset;
  const insTo = insFrom + insertLen;
  if (insertLen <= 0 || insTo <= insFrom || insTo > tr.doc.content.size) return tr;
  const existing = tr.doc.slice(insFrom, insTo);
  return tr.replace(insFrom, insTo, sliceWithMark(existing, mark));
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
    const hasDeletion = to > from;
    const hasInsertion = step.slice.content.size > 0;
    if (!hasDeletion && !hasInsertion) continue;

    if (hasDeletion && !hasInsertion && isOwnPendingInsertRange(beforeDoc, from, to, author)) {
      continue;
    }

    const extended = !hasDeletion && hasInsertion ? ownInsertAttrs(beforeDoc, from, author) : null;
    const attrs = extended ?? {
      id: newSuggestionId(),
      author: author.trim(),
      ts: suggestionTs(),
    };
    const insMark = newState.schema.marks.suggestion_insert!.create(attrs);
    const delMark = newState.schema.marks.suggestion_delete!.create(attrs);
    const mapFrom = tr.mapping.map(from);
    const deletedSlice = beforeDoc.slice(from, to);

    if (hasDeletion && !hasInsertion) {
      tr = tr.replace(mapFrom, mapFrom, sliceWithMark(deletedSlice, delMark));
    } else if (!hasDeletion && hasInsertion) {
      tr = markInsertedSlice(tr, beforeDoc, step, mapFrom, insMark, 0, false);
    } else {
      tr = tr.replace(mapFrom, mapFrom, sliceWithMark(deletedSlice, delMark));
      tr = markInsertedSlice(tr, beforeDoc, step, mapFrom, insMark, deletedSlice.size, true);
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
  addProseMirrorPlugins() {
    const active = () => this.options.active();
    const author = () => this.options.author();
    return [
      new Plugin({
        key: humanTrackKey,
        state: {
          init: () => ({ active: active(), author: author() }),
          apply: () => ({ active: active(), author: author() }),
        },
        appendTransaction: (transactions, oldState, newState) => {
          if (!active()) return null;
          return humanTrackAppendTransaction(transactions, oldState, newState, author());
        },
      }),
    ];
  },
});
