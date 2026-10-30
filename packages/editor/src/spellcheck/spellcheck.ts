/**
 * Spelling and grammar decorations (#159). Decoration-only: never writes Yjs or review marks.
 */
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { lintableBlockText, mapLintSpan, surfaceWord } from './extract';
import type { SpellIssue, SpellLintResult, SpellcheckOptions } from './types';

export const spellcheckKey = new PluginKey<SpellPluginState>('coauthorSpellcheck');

export interface SpellPluginState {
  decorations: DecorationSet;
  issues: SpellIssue[];
}

const emptyState = (): SpellPluginState => ({
  decorations: DecorationSet.empty,
  issues: [],
});

function blockAtPos(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) return { node, pos: $pos.before(d) };
  }
  return null;
}

function blocksInRange(doc: PMNode, from: number, to: number): number[] {
  const out = new Set<number>();
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) out.add(pos);
    return !node.isTextblock;
  });
  return [...out];
}

function isBlockVisible(view: EditorView, blockPos: number): boolean {
  try {
    const dom = view.nodeDOM(blockPos);
    if (!(dom instanceof HTMLElement)) return true;
    const editorRect = view.dom.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    return rect.bottom >= editorRect.top && rect.top <= editorRect.bottom;
  } catch {
    return true;
  }
}

function issuesToDecorations(doc: PMNode, issues: SpellIssue[]): DecorationSet {
  const decos = issues.map((issue) =>
    Decoration.inline(issue.from, issue.to, {
      class:
        issue.kind === 'spelling'
          ? 'spell-lint spell-lint--spelling'
          : 'spell-lint spell-lint--grammar',
      'data-spell-id': issue.id,
    }),
  );
  return DecorationSet.create(doc, decos);
}

function blockPosForIssue(doc: PMNode, from: number): number | null {
  return blockAtPos(doc, from)?.pos ?? null;
}

function mergeIssuesForBlock(
  doc: PMNode,
  existing: SpellIssue[],
  blockPos: number,
  blockIssues: SpellIssue[],
): SpellIssue[] {
  const rest = existing.filter((i) => blockPosForIssue(doc, i.from) !== blockPos);
  return rest.concat(blockIssues);
}

function resultsToIssues(
  doc: PMNode,
  blockPos: number,
  map: number[],
  results: SpellLintResult[],
): SpellIssue[] {
  const issues: SpellIssue[] = [];
  for (const r of results) {
    const mapped = mapLintSpan(map, r.start, r.end);
    if (!mapped) continue;
    const { from, to } = mapped;
    issues.push({
      id: `${blockPos}:${from}:${to}:${r.kind}`,
      from,
      to,
      kind: r.kind,
      message: r.message,
      suggestions: r.suggestions,
      word: surfaceWord(doc, from, to),
    });
  }
  return issues;
}

export function spellIssueAtPos(state: EditorState, pos: number): SpellIssue | undefined {
  const plugin = spellcheckKey.getState(state);
  if (!plugin) return undefined;
  return plugin.issues.find((i) => pos >= i.from && pos < i.to);
}

export function invalidateSpellBlock(editor: Editor, blockPos: number): void {
  const view = editor.view;
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(spellcheckKey, { invalidate: blockPos }));
}

export const Spellcheck = Extension.create<SpellcheckOptions>({
  name: 'spellcheck',

  addOptions() {
    return {
      enabled: () => true,
      checkSpelling: () => true,
      checkGrammar: () => true,
      lint: async () => [],
      debounceMs: 450,
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dirtyBlocks = new Set<number>();
    let lintGeneration = 0;
    let viewRef: EditorView | null = null;

    const runLint = async (view: EditorView) => {
      if (view.isDestroyed || !opts.enabled()) {
        dirtyBlocks.clear();
        return;
      }
      if (!opts.checkSpelling() && !opts.checkGrammar()) {
        view.dispatch(
          view.state.tr
            .setMeta(spellcheckKey, { set: emptyState() })
            .setMeta('addToHistory', false),
        );
        dirtyBlocks.clear();
        return;
      }
      const blocks = [...dirtyBlocks].filter((p) => isBlockVisible(view, p));
      dirtyBlocks.clear();
      if (!blocks.length) return;
      const gen = ++lintGeneration;
      let issues = spellcheckKey.getState(view.state)?.issues ?? [];
      for (const blockPos of blocks) {
        const block = view.state.doc.nodeAt(blockPos);
        if (!block?.isTextblock) continue;
        const { text, map } = lintableBlockText(block, blockPos);
        if (!text.trim()) {
          issues = mergeIssuesForBlock(view.state.doc, issues, blockPos, []);
          continue;
        }
        const results = await opts.lint(text, blockPos);
        if (gen !== lintGeneration || view.isDestroyed) return;
        if (results === null) continue;
        const blockIssues = resultsToIssues(view.state.doc, blockPos, map, results);
        issues = mergeIssuesForBlock(view.state.doc, issues, blockPos, blockIssues);
      }
      view.dispatch(
        view.state.tr
          .setMeta(spellcheckKey, {
            set: { decorations: issuesToDecorations(view.state.doc, issues), issues },
          })
          .setMeta('addToHistory', false),
      );
    };

    const schedule = () => {
      if (!viewRef) return;
      clearTimeout(timer);
      timer = setTimeout(() => void runLint(viewRef!), opts.debounceMs ?? 450);
    };

    const markDirty = (view: EditorView, from: number, to: number) => {
      for (const p of blocksInRange(view.state.doc, from, to)) dirtyBlocks.add(p);
      schedule();
    };

    return [
      new Plugin<SpellPluginState>({
        key: spellcheckKey,
        state: {
          init: emptyState,
          apply(tr, prev) {
            const meta = tr.getMeta(spellcheckKey) as
              { set?: SpellPluginState; invalidate?: number; rescan?: number[] } | undefined;
            if (meta?.set) return meta.set;
            if (meta?.invalidate !== undefined) {
              const issues = mergeIssuesForBlock(tr.doc, prev.issues, meta.invalidate, []);
              return { issues, decorations: issuesToDecorations(tr.doc, issues) };
            }
            if (meta?.rescan) {
              for (const p of meta.rescan) dirtyBlocks.add(p);
              schedule();
            }
            if (tr.docChanged) {
              return {
                issues: prev.issues,
                decorations: prev.decorations.map(tr.mapping, tr.doc),
              };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => spellcheckKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view(view) {
          viewRef = view;
          view.state.doc.descendants((node, pos) => {
            if (node.isTextblock) dirtyBlocks.add(pos);
          });
          schedule();
          return {
            update(v, prevState) {
              if (!opts.enabled()) return;
              if (v.state.doc.eq(prevState.doc)) return;
              const { from, to } = v.state.selection;
              markDirty(v, from, to);
            },
            destroy() {
              clearTimeout(timer);
              viewRef = null;
            },
          };
        },
      }),
    ];
  },
});

/** Re-run lint for visible text blocks (dictionary / ignore updates). */
export function refreshSpellcheck(editor: Editor): void {
  const view = editor.view;
  if (view.isDestroyed) return;
  const blocks: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && isBlockVisible(view, pos)) blocks.push(pos);
    return !node.isTextblock;
  });
  view.dispatch(
    view.state.tr.setMeta(spellcheckKey, { rescan: blocks }).setMeta('addToHistory', false),
  );
}
