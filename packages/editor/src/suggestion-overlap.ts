/**
 * Overlap decorations (#179): gutter hint when a single-author view hides other pending
 * suggestions on the same range, and neutral All-view overlap underline + count badge.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { targetKey, type SuggestionTarget } from './decisions';

export const suggestionOverlapKey = new PluginKey<DecorationSet>('swarmdraftSuggestionOverlap');

const SUGGESTION = new Set(['suggestion_insert', 'suggestion_delete', 'format_change']);

export interface SuggestionSpan {
  from: number;
  to: number;
  author: string;
  kind: SuggestionTarget['kind'];
  id: string;
}

export interface OverlapCluster {
  from: number;
  to: number;
  spans: SuggestionSpan[];
}

function mergeClusterSpans(into: OverlapCluster, span: SuggestionSpan): void {
  into.from = Math.min(into.from, span.from);
  into.to = Math.max(into.to, span.to);
  const map = new Map(into.spans.map((s) => [targetKey(s), s]));
  map.set(targetKey(span), span);
  into.spans = [...map.values()];
}

/** Intervals where more than one author has pending suggestion marks. */
export function findOverlapClusters(spans: readonly SuggestionSpan[]): OverlapCluster[] {
  const sorted = [...spans]
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  if (sorted.length < 2) return [];
  const out: OverlapCluster[] = [];
  let cur: OverlapCluster = { from: sorted[0]!.from, to: sorted[0]!.to, spans: [sorted[0]!] };

  for (const s of sorted.slice(1)) {
    if (s.from >= cur.to) {
      if (new Set(cur.spans.map((x) => x.author)).size >= 2) out.push(cur);
      cur = { from: s.from, to: s.to, spans: [s] };
    } else mergeClusterSpans(cur, s);
  }
  if (new Set(cur.spans.map((x) => x.author)).size >= 2) out.push(cur);
  return out;
}

export function gatherSuggestionSpans(doc: PMNode): SuggestionSpan[] {
  const out: SuggestionSpan[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const seen = new Set<string>();
    for (const m of node.marks) {
      if (!SUGGESTION.has(m.type.name)) continue;
      const id = String(m.attrs.id ?? '');
      const key = `${m.type.name}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        from: pos,
        to: pos + node.nodeSize,
        author: String(m.attrs.author ?? '').trim(),
        kind: m.type.name as SuggestionTarget['kind'],
        id,
      });
    }
    return false;
  });
  return out;
}

export function gutterClustersForFilter(
  clusters: readonly OverlapCluster[],
  filterAuthor: string,
): { cluster: OverlapCluster; hiddenAuthors: string[]; hiddenCount: number }[] {
  const out: { cluster: OverlapCluster; hiddenAuthors: string[]; hiddenCount: number }[] = [];
  for (const cluster of clusters) {
    const visible = cluster.spans.some((s) => s.author === filterAuthor);
    if (!visible) continue;
    const hiddenAuthors = [
      ...new Set(cluster.spans.map((s) => s.author).filter((a) => a && a !== filterAuthor)),
    ];
    if (!hiddenAuthors.length) continue;
    const hiddenCount = cluster.spans.filter((s) => hiddenAuthors.includes(s.author)).length;
    out.push({ cluster, hiddenAuthors, hiddenCount });
  }
  return out;
}

export function overlapBadgeAriaLabel(
  cluster: OverlapCluster,
  nameOf: (author: string) => string,
): string {
  const names = [...new Set(cluster.spans.map((s) => nameOf(s.author)))];
  const n = cluster.spans.length;
  const who =
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
      : (names[0] ?? 'others');
  return `${n} suggestion${n === 1 ? '' : 's'}, by ${who}`;
}

export function gutterDotAriaLabel(
  hiddenCount: number,
  nameOf: (author: string) => string,
  author: string,
): string {
  const who = nameOf(author);
  return `${hiddenCount} more from ${who} · Show`;
}

/** Visible gutter control copy (ov2). */
export function gutterHintText(
  hiddenCount: number,
  nameOf: (author: string) => string,
  author: string,
): string {
  return gutterDotAriaLabel(hiddenCount, nameOf, author);
}

export type OverlapAuthorVisible = (author: string) => boolean;

export interface OverlapUiHandlers {
  onOverlapClick: (cluster: OverlapCluster, anchor: { x: number; y: number }) => void;
  onGutterClick: (author: string) => void;
  labelAuthor: (author: string) => string;
}

function decorate(
  doc: PMNode,
  filterAuthor: string | null,
  authorVisible: OverlapAuthorVisible,
  handlers: OverlapUiHandlers,
): DecorationSet {
  const allSpans = gatherSuggestionSpans(doc);
  const clusters = findOverlapClusters(allSpans);
  const decos: Decoration[] = [];

  if (filterAuthor) {
    for (const { cluster, hiddenAuthors, hiddenCount } of gutterClustersForFilter(
      clusters,
      filterAuthor,
    )) {
      const targetAuthor = hiddenAuthors[0]!;
      const label = gutterDotAriaLabel(hiddenCount, handlers.labelAuthor, targetAuthor);
      const hint = gutterHintText(hiddenCount, handlers.labelAuthor, targetAuthor);
      decos.push(
        Decoration.widget(
          cluster.from,
          () => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'suggest-overlap-gutter';
            btn.dataset.overlapGutter = targetAuthor;
            btn.dataset.test = 'overlap-gutter';
            btn.setAttribute('aria-label', label);
            btn.title = label;
            const ring = document.createElement('span');
            ring.className = 'suggest-overlap-gutter-ring';
            ring.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.className = 'suggest-overlap-gutter-hint';
            text.textContent = hint;
            btn.append(ring, text);
            return btn;
          },
          { side: -1, key: `gutter:${cluster.from}:${targetAuthor}` },
        ),
      );
    }
    return DecorationSet.create(doc, decos);
  }

  for (const cluster of clusters) {
    const aria = overlapBadgeAriaLabel(cluster, handlers.labelAuthor);
    decos.push(
      Decoration.inline(cluster.from, cluster.to, {
        class: 'suggest-overlap',
        'data-suggest-overlap': '',
        'data-overlap-from': String(cluster.from),
        'data-overlap-to': String(cluster.to),
        'aria-label': aria,
        role: 'button',
        tabindex: '0',
      }),
    );
    decos.push(
      Decoration.widget(
        cluster.to,
        () => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'suggest-overlap-badge';
          btn.dataset.overlapBadge = '';
          btn.dataset.overlapFrom = String(cluster.from);
          btn.dataset.overlapTo = String(cluster.to);
          btn.dataset.test = 'overlap-badge';
          btn.setAttribute('aria-hidden', 'true');
          btn.tabIndex = -1;
          btn.textContent = String(cluster.spans.length);
          return btn;
        },
        { side: 1, key: `badge:${cluster.from}:${cluster.to}` },
      ),
    );
  }
  return DecorationSet.create(doc, decos);
}

export const SuggestionOverlap = Extension.create<{
  filterAuthor: () => string | null;
  authorVisible: OverlapAuthorVisible;
  handlers: () => OverlapUiHandlers;
}>({
  name: 'suggestionOverlap',
  addOptions: () => ({
    filterAuthor: () => null,
    authorVisible: () => true,
    handlers: () => ({
      onOverlapClick: () => {},
      onGutterClick: () => {},
      labelAuthor: (a) => a,
    }),
  }),
  addProseMirrorPlugins() {
    const filterAuthor = () => this.options.filterAuthor();
    const authorVisible = (a: string) => this.options.authorVisible(a);
    const handlers = () => this.options.handlers();
    return [
      new Plugin<DecorationSet>({
        key: suggestionOverlapKey,
        state: {
          init: (_, state: EditorState) =>
            decorate(state.doc, filterAuthor(), authorVisible, handlers()),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta(suggestionOverlapKey)
              ? decorate(tr.doc, filterAuthor(), authorVisible, handlers())
              : old,
        },
        props: {
          decorations: (state) => suggestionOverlapKey.getState(state),
          handleDOMEvents: {
            click(view, event) {
              const t = event.target;
              if (!(t instanceof HTMLElement)) return false;
              const gutter = t.closest('[data-overlap-gutter]');
              if (gutter instanceof HTMLElement && gutter.dataset.overlapGutter) {
                event.preventDefault();
                handlers().onGutterClick(gutter.dataset.overlapGutter);
                return true;
              }
              const badge = t.closest('[data-overlap-badge]');
              const inline = t.closest('[data-suggest-overlap]');
              if (badge || inline) {
                const el = (badge ?? inline) as HTMLElement;
                const from = Number(el.dataset.overlapFrom);
                const to = Number(el.dataset.overlapTo);
                if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
                const spans = gatherSuggestionSpans(view.state.doc);
                const cluster = findOverlapClusters(spans).find(
                  (c) => c.from === from && c.to === to,
                );
                if (!cluster) return false;
                event.preventDefault();
                const rect = (badge ?? inline)!.getBoundingClientRect();
                handlers().onOverlapClick(cluster, {
                  x: rect.left + rect.width / 2,
                  y: rect.bottom,
                });
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

export function refreshSuggestionOverlap(view: {
  state: EditorState;
  dispatch: (tr: EditorState['tr']) => void;
}) {
  view.dispatch(view.state.tr.setMeta(suggestionOverlapKey, true).setMeta('addToHistory', false));
}
