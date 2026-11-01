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

export const findHighlightKey = new PluginKey<FindHighlightState>('swarmdraftFindHighlight');

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

interface SearchSegment {
  /** Concatenated searchable text for one run (breaks at suggestion marks). */
  text: string;
  /** Document position for each code unit in `text`. */
  map: number[];
}

/** One searchable string per contiguous non-suggestion text (formatting may split nodes). */
function searchSegments(block: PMNode, blockPos: number): SearchSegment[] {
  const base = blockPos + 1;
  const segments: SearchSegment[] = [];
  let text = '';
  const map: number[] = [];

  const flush = () => {
    if (text.length) segments.push({ text, map: [...map] });
    text = '';
    map.length = 0;
  };

  block.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    if (node.marks.some(isSuggestion)) {
      flush();
      return true;
    }
    const nodeStart = base + pos;
    for (let i = 0; i < node.text.length; i++) {
      map.push(nodeStart + i);
      text += node.text[i]!;
    }
    return true;
  });
  flush();
  return segments;
}

function matchesInBlock(block: PMNode, blockPos: number, re: RegExp): FindMatch[] {
  const out: FindMatch[] = [];
  for (const seg of searchSegments(block, blockPos)) {
    const blockRe = new RegExp(re.source, re.flags);
    for (const m of seg.text.matchAll(blockRe)) {
      const fromIdx = m.index!;
      const toIdx = fromIdx + m[0].length;
      const from = seg.map[fromIdx];
      const toPos = seg.map[toIdx - 1];
      if (from === undefined || toPos === undefined) continue;
      out.push({ from, to: toPos + 1 });
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

/** Scroll a match into the editor viewport without changing focus or document selection. */
export function scrollFindMatchIntoView(editor: Editor, match: FindMatch): void {
  const { view } = editor;
  if (view.isDestroyed) return;
  const dom = view.domAtPos(match.from);
  let node: Node | null = dom.node;
  if (node.nodeType === 3) node = node.parentNode;
  if (node instanceof HTMLElement) {
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
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
