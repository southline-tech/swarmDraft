/**
 * Find & replace in the manuscript (#53). Matches never span text blocks; text inside pending
 * suggestions is skipped. Replace runs in one history step per operation.
 */
import type { Editor } from '@tiptap/core';
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import { SUGGESTION_MARKS } from './content';

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface FindHighlightState {
  matches: FindMatch[];
  active: number;
}

export const findHighlightKey = new PluginKey<FindHighlightState>('coauthorFindHighlight');

const isSuggestion = (m: PMMark) => (SUGGESTION_MARKS as readonly string[]).includes(m.type.name);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build a global RegExp for find, or null when the query is empty. */
export function buildFindRegExp(query: string, opts: FindOptions): RegExp | null {
  const q = query;
  if (!q) return null;
  const body = opts.wholeWord
    ? `(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(q)}(?![\\p{L}\\p{M}\\p{N}])`
    : escapeRe(q);
  return new RegExp(body, opts.matchCase ? 'gu' : 'giu');
}

function searchablePieces(block: PMNode, blockPos: number): { start: number; text: string }[] {
  const base = blockPos + 1;
  const pieces: { start: number; text: string }[] = [];
  block.descendants((node, pos) => {
    if (node.isText && node.text && !node.marks.some(isSuggestion))
      pieces.push({ start: base + pos, text: node.text });
    return true;
  });
  return pieces;
}

function matchesInBlock(block: PMNode, blockPos: number, re: RegExp): FindMatch[] {
  const pieces = searchablePieces(block, blockPos);
  const out: FindMatch[] = [];
  for (const p of pieces) {
    for (const m of p.text.matchAll(re)) {
      out.push({ from: p.start + m.index!, to: p.start + m.index! + m[0].length });
    }
  }
  return out;
}

/** All matches in reading order; never spans two text blocks or suggestion text. */
export function listFindMatches(doc: PMNode, query: string, opts: FindOptions): FindMatch[] {
  const re = buildFindRegExp(query, opts);
  if (!re) return [];
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    matches.push(...matchesInBlock(node, pos, re));
    return false;
  });
  return matches;
}

function decorationsFor(
  state: EditorState,
  { matches, active }: FindHighlightState,
): DecorationSet {
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === active ? 'find-match find-match--active' : 'find-match',
    }),
  );
  return DecorationSet.create(state.doc, decos);
}

export const FindHighlight = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindHighlightState>({
        key: findHighlightKey,
        state: {
          init: () => ({ matches: [], active: 0 }),
          apply(tr, prev) {
            const meta = tr.getMeta(findHighlightKey) as FindHighlightState | undefined;
            if (meta !== undefined) return meta;
            if (tr.docChanged && prev.matches.length) return { matches: [], active: 0 };
            return prev;
          },
        },
        props: {
          decorations: (state) => {
            const s = findHighlightKey.getState(state);
            if (!s?.matches.length) return DecorationSet.empty;
            return decorationsFor(state, s);
          },
        },
      }),
    ];
  },
});

export function updateFindHighlight(editor: Editor, matches: FindMatch[], active: number): void {
  const { view } = editor;
  if (view.isDestroyed) return;
  view.dispatch(
    view.state.tr.setMeta(findHighlightKey, { matches, active }).setMeta('addToHistory', false),
  );
}

function replacementText(editor: Editor, from: number, text: string) {
  const marks = editor.state.doc
    .resolve(from)
    .marks()
    .filter((m) => !isSuggestion(m));
  return editor.schema.text(text, marks);
}

/** Replace one match or all matches in a single undo step. Returns the new active index. */
export function replaceFindMatches(
  editor: Editor,
  query: string,
  replacement: string,
  opts: FindOptions,
  mode: 'one' | 'all',
  activeIndex: number,
): number {
  const matches = listFindMatches(editor.state.doc, query, opts);
  if (!matches.length) return 0;

  const tr = editor.state.tr;
  if (mode === 'one') {
    const i = Math.min(Math.max(activeIndex, 0), matches.length - 1);
    const { from, to } = matches[i]!;
    tr.replaceWith(from, to, replacementText(editor, from, replacement));
  } else {
    for (let i = matches.length - 1; i >= 0; i--) {
      const { from, to } = matches[i]!;
      tr.replaceWith(from, to, replacementText(editor, from, replacement));
    }
  }
  const before = editor.state.doc;
  editor.view.dispatch(tr);
  if (editor.state.doc.eq(before)) return activeIndex;

  const next = listFindMatches(editor.state.doc, query, opts);
  if (!next.length) return 0;
  if (mode === 'one') {
    const i = Math.min(activeIndex, next.length - 1);
    return i;
  }
  return 0;
}
