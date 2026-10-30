/**
 * Human track changes for formatting (#160): while active, toolbar inline toggles and paragraph
 * style changes become `format_change` marks under the writer profile instead of silent edits.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, type Step } from '@tiptap/pm/transform';
import {
  formatChangeAttrs,
  PARAGRAPH_STYLE_TARGET,
  TRACKED_INLINE_FORMATS,
  type TrackedInlineFormat,
} from './format-change';
import { humanTrackKey, REVIEW_EDIT_TOKEN, reviewGuardKey } from './review';
import { isBindingTransaction } from './ysource';

export const formatTrackKey = new PluginKey<{ active: boolean; author: string }>(
  'coauthorFormatTrack',
);

function skipFormatTrack(tr: Transaction): boolean {
  if (tr.getMeta(reviewGuardKey) === REVIEW_EDIT_TOKEN) return true;
  if (tr.getMeta(formatTrackKey)) return true;
  if (tr.getMeta(humanTrackKey)) return true;
  if (isBindingTransaction(tr)) return true;
  return false;
}

function newFormatId(): string {
  return crypto.randomUUID();
}

function trackedInline(name: string): name is TrackedInlineFormat {
  return (TRACKED_INLINE_FORMATS as readonly string[]).includes(name);
}

function addFormatChangeOnRange(
  tr: Transaction,
  schema: EditorState['schema'],
  from: number,
  to: number,
  author: string,
  target: string,
  before: string,
  after: string,
): Transaction {
  if (from >= to || !author.trim()) return tr;
  const mark = schema.marks.format_change!.create(
    formatChangeAttrs({
      id: newFormatId(),
      author: author.trim(),
      target,
      before,
      after,
    }),
  );
  return tr.addMark(from, to, mark);
}

function paragraphTextRange(doc: PMNode, pos: number): { from: number; to: number } | null {
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== 'paragraph' || !node.content.size) return null;
  const from = pos + 1;
  return { from, to: from + node.content.size };
}

/**
 * After a direct format edit lands, annotate it with `format_change` in the same history step.
 */
export function formatTrackAppendTransaction(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  author: string,
): Transaction | null {
  const src = transactions.find((t) => t.docChanged && !skipFormatTrack(t));
  if (!src || !author.trim()) return null;

  let tr = newState.tr;
  let changed = false;

  const applyStep = (step: Step) => {
    if (step instanceof AddMarkStep && trackedInline(step.mark.type.name)) {
      const name = step.mark.type.name;
      const from = tr.mapping.map(step.from);
      const to = tr.mapping.map(step.to);
      tr = addFormatChangeOnRange(tr, newState.schema, from, to, author, name, '0', '1');
      changed = true;
      return;
    }
    if (step instanceof RemoveMarkStep && trackedInline(step.mark.type.name)) {
      const name = step.mark.type.name;
      const from = tr.mapping.map(step.from);
      const to = tr.mapping.map(step.to);
      tr = addFormatChangeOnRange(tr, newState.schema, from, to, author, name, '1', '0');
      changed = true;
    }
  };

  for (let i = 0; i < src.steps.length; i++) {
    applyStep(src.steps[i]!);
  }

  newState.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return;
    const oldNode = oldState.doc.nodeAt(pos);
    if (!oldNode || oldNode.type.name !== 'paragraph') return;
    const before = String(oldNode.attrs.style ?? 'body');
    const after = String(node.attrs.style ?? 'body');
    if (before === after) return;
    const range = paragraphTextRange(tr.doc, pos);
    if (!range) return;
    tr = addFormatChangeOnRange(
      tr,
      newState.schema,
      range.from,
      range.to,
      author,
      PARAGRAPH_STYLE_TARGET,
      before,
      after,
    );
    changed = true;
  });

  if (!changed) return null;
  tr.setMeta(formatTrackKey, true);
  tr.setMeta(reviewGuardKey, REVIEW_EDIT_TOKEN);
  return tr;
}

export const FormatTrackChanges = Extension.create({
  name: 'formatTrackChanges',
  addOptions: () => ({
    active: (): boolean => false,
    author: (): string => '',
  }),
  addProseMirrorPlugins() {
    const active = () => this.options.active();
    const author = () => this.options.author();
    return [
      new Plugin({
        key: formatTrackKey,
        state: {
          init: () => ({ active: active(), author: author() }),
          apply: () => ({ active: active(), author: author() }),
        },
        appendTransaction: (transactions, oldState, newState) => {
          if (!active()) return null;
          return formatTrackAppendTransaction(transactions, oldState, newState, author());
        },
      }),
    ];
  },
});
