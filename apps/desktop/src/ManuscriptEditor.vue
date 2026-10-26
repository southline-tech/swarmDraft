<script setup lang="ts">
/**
 * Manuscript editor (RAD-202): Tiptap with the manuscript schema, the formatting toolbar (RAD-254),
 * and a read-only list of the comments and tracked changes in the document.
 *
 * With `doc`, the editor is bound to that section Y.Doc through y-prosemirror
 * (`collaborativeEditorOptions`): every edit is written to the doc as it is typed, and changes
 * from other writers are content-checked before they apply. `content` opens an unbound snapshot.
 */
import { computed, onBeforeUnmount, onMounted, shallowRef, toRaw, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import type { Editor, EditorOptions, JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import EditorToolbar from './toolbar/EditorToolbar.vue';
import StatusBar, { type SaveState } from './status/StatusBar.vue';
import { countWords, watchBookWords } from './status/wordcount';
import { loadZoom, saveZoom } from './desk/zoom';
import ReviewPanel from './review/ReviewPanel.vue';
import {
  DecisionLog,
  keyOf,
  groupChanges,
  inForeignInput,
  loadCollapsed,
  resolveCurrent,
  reviewActionFor,
  saveCollapsed,
  step,
  toggleAuthor,
  authorsOf,
  visibleItems,
  type AuthorFilter,
} from './review/review-state';
import {
  collaborativeEditorOptions,
  collectReviewItems,
  listSuggestions,
  manuscriptEditorOptions,
  type Decision,
  type DecisionRecord,
  type ReviewItem,
  type SuggestionItem,
  type SuggestionTarget,
} from '@coauthor/editor';
import { applyReviewDecision } from './review/apply';
import type { DocNode } from '@coauthor/schema';

const props = defineProps<{
  /** The section's Y.Doc to bind to. When set it wins and `content` is ignored. */
  doc?: Y.Doc;
  /** An unbound snapshot, used only when `doc` is not set. */
  content?: JSONContent;
  /** No editing (e.g. the session is closed); edits would be dropped. */
  readonly?: boolean;
  /** Whether the parent's chapter navigator is showing; reflected on the toolbar's Chapters button. */
  navigatorOpen?: boolean;
  /** Status bar (RAD-256): the open chapter's title, when known. */
  chapterTitle?: string;
  /** Every section doc of the manuscript, for the live book word count. */
  /** Every section doc in outline order; re-derived from the outline so adds/deletes show. */
  bookDocs?: readonly Y.Doc[];
  /** The chapter's docs (its own and its scenes'); without it only this doc is counted. */
  chapterDocs?: Y.Doc[];
  /** Save status, only when the parent actually knows it. */
  saveState?: SaveState;
  /** Display labels per raw agent id for the review panel (ids are what decisions key on). */
  authorLabels?: Record<string, string>;
}>();
/** `reload` asks the parent to reopen the section from its source (e.g. by re-mounting). */
const emit = defineEmits<{
  change: [doc: JSONContent];
  reload: [];
  /** The toolbar's chapters toggle; the parent owns the navigator. */
  'toggle-navigator': [];
  /** Human accept/reject decisions as recorded (and withdrawn again on undo). */
  decisions: [records: DecisionRecord[]];
}>();
/** Review list visibility, driven by the toolbar's review toggle. */
const reviewOpen = shallowRef(true);

/** Page zoom in percent (RAD-255): scales the 6x9 page without reflowing it, persisted per user. */
const zoom = shallowRef(loadZoom());
watch(zoom, (z) => saveZoom(z));

const review = shallowRef<ReviewItem[]>([]);
const comments = computed(() => review.value.filter((r) => r.type === 'comment_anchor'));

/** Review step-through (RAD-258). Suggestions in document order, keyed on raw author id. */
const suggestions = shallowRef<SuggestionItem[]>([]);
const filter = shallowRef<AuthorFilter>(null);
const currentKey = shallowRef<string | null>(null);
let currentIndex = -1;
const collapsed = shallowRef(loadCollapsed());
watch(collapsed, (v) => saveCollapsed(v));
const changes = computed(() => groupChanges(suggestions.value));
const visible = computed(() => visibleItems(changes.value, filter.value));
const log = new DecisionLog();

function refreshReview(e: Editor) {
  review.value = collectReviewItems(e.state.doc);
  suggestions.value = listSuggestions(e.state.doc.toJSON() as DocNode);
  // Undo/redo of a decision brings a suggestion back or removes it again: keep the log in step.
  if (log.sync(suggestions.value)) emit('decisions', log.records());
  const i = resolveCurrent(visible.value, currentKey.value, currentIndex);
  currentIndex = i;
  currentKey.value = i >= 0 ? visible.value[i]!.key : null;
}
watch(filter, () => editor.value && refreshReview(editor.value));

/** First text position of a suggestion, found by (mark type, attrs.id). */
function rangeOf(e: Editor, t: SuggestionTarget): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  e.state.doc.descendants((n, pos) => {
    if (!n.isText) return true;
    if (n.marks.some((m) => m.type.name === t.kind && String(m.attrs.id) === t.id)) {
      if (from < 0) from = pos;
      to = pos + n.nodeSize;
    }
    return true;
  });
  return from < 0 ? null : { from, to };
}
function select(key: string) {
  const e = editor.value;
  const item = visible.value.find((v) => v.key === key);
  if (!e || !item) return;
  currentKey.value = key;
  currentIndex = visible.value.indexOf(item);
  const parts = item.targets.map((t) => rangeOf(e, t)).filter((r) => !!r);
  if (!parts.length) return;
  const r = {
    from: Math.min(...parts.map((p) => p.from)),
    to: Math.max(...parts.map((p) => p.to)),
  };
  e.chain().setTextSelection(r).scrollIntoView().run();
}
function move(dir: 1 | -1) {
  const list = visible.value;
  const i = step(
    list.length,
    list.findIndex((v) => v.key === currentKey.value),
    dir,
  );
  if (i >= 0) select(list[i]!.key);
}
/** Human-only: runs through the trusted review transaction on the live editor. */
function decide(targets: SuggestionTarget[], decision: Decision) {
  const e = editor.value;
  if (!e || !targets.length || !e.isEditable) return;
  const keys = new Set(targets.map(keyOf));
  const decided = suggestions.value.filter((s) => keys.has(keyOf(s)));
  if (!applyReviewDecision(e.view, { targets, decision })) return;
  const decidedAt = new Date().toISOString();
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  log.record(
    decided.map((s) => ({ kind: s.kind, id: s.id, status, decidedAt, decidedBy: 'author' })),
  );
  refreshReview(e);
  emit('decisions', log.records());
  // Auto-advance: the change now at the old position becomes current.
  if (currentKey.value) select(currentKey.value);
}
const targetOf = (key: string | null) => changes.value.find((c) => c.key === key)?.targets ?? [];
const decideCurrent = (d: Decision) => decide(targetOf(currentKey.value), d);
const decideOne = (key: string, d: Decision) => {
  currentKey.value = key;
  currentIndex = visible.value.findIndex((v) => v.key === key);
  decide(targetOf(key), d);
};
/** Bulk decision over the change keys locked when the confirmation opened. */
const decideVisible = (d: Decision, keys: readonly string[]) =>
  decide(
    keys.flatMap((k) => targetOf(k)),
    d,
  );
const onToggleAuthor = (a: string) =>
  (filter.value = toggleAuthor(authorsOf(suggestions.value), filter.value, a));

function onKeydown(ev: KeyboardEvent) {
  const action = reviewActionFor(ev);
  if (!action) return;
  if (action !== 'toggle') {
    // Only while the panel is open and focus is not in some other text field.
    if (!reviewOpen.value || collapsed.value) return;
    if (inForeignInput(ev.target, editor.value?.view.dom ?? null)) return;
  }
  ev.preventDefault();
  if (action === 'toggle') {
    if (reviewOpen.value) collapsed.value = !collapsed.value;
  } else if (action === 'next') move(1);
  else if (action === 'prev') move(-1);
  else decideCurrent(action === 'accept' ? 'accept' : 'reject');
}
onMounted(() => window.addEventListener('keydown', onKeydown, true));

/** Status bar counts (RAD-256), recounted off the typing path. */
const chapterWords = shallowRef<number>();
const selectionWords = shallowRef(0);
let countTimer: ReturnType<typeof setTimeout> | undefined;
const countChapter = (e: Editor) =>
  !props.chapterDocs?.length &&
  (chapterWords.value = countWords(e.state.doc.textBetween(0, e.state.doc.content.size, ' ', ' ')));
function scheduleCount(e: Editor) {
  if (props.chapterDocs?.length) return; // counted from the chapter's docs instead
  clearTimeout(countTimer);
  countTimer = setTimeout(() => countChapter(e), 250);
}
function countSelection(e: Editor) {
  const { from, to, empty } = e.state.selection;
  selectionWords.value = empty ? 0 : countWords(e.state.doc.textBetween(from, to, ' ', ' '));
}
const bookWords = shallowRef<number>();
let stopBook = () => {};
let stopChapter = () => {};
watch(
  () => props.chapterDocs,
  (docs, prev) => {
    // The parent may pass a fresh array each render; only resubscribe when the docs change.
    if (prev && docs && prev.length === docs.length && prev.every((d, i) => d === docs[i])) return;
    stopChapter();
    stopChapter = () => {};
    if (docs?.length)
      stopChapter = watchBookWords(
        docs.map((d) => toRaw(d)),
        (n) => (chapterWords.value = n),
      );
  },
  { immediate: true },
);
watch(
  () => props.bookDocs,
  (docs, prev) => {
    // A fresh array each render; resubscribe only when a section was added or removed, which
    // also drops the observers (and cached counts) of deleted docs.
    if (prev && docs && prev.length === docs.length && prev.every((d, i) => d === docs[i])) return;
    stopBook();
    bookWords.value = undefined;
    if (docs)
      stopBook = watchBookWords(
        docs.map((d) => toRaw(d)),
        (n) => (bookWords.value = n),
      );
  },
  { immediate: true },
);

/**
 * Put the cursor at the start of the first body text, not in the chapter heading, so typing
 * right after opening goes into the prose. Only while the cursor is still at the very start
 * (the author has not moved it); returns whether it moved.
 */
function placeCursorInBody(e: Editor): boolean {
  const { doc, selection } = e.state;
  if (!selection.empty || selection.from > 1) return false;
  let target = -1;
  doc.descendants((node, pos) => {
    if (target >= 0) return false;
    if (!node.isTextblock) return true;
    const heading = node.type.name === 'heading' || node.attrs.style === 'heading';
    if (!heading && node.type.name !== 'scene_break') target = pos + 1;
    return false;
  });
  if (target < 0 || target === selection.from) return false;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(doc, target)));
  return true;
}

/** Set when the content does not fit the schema; the editor is then read-only and never emits. */
const loadError = shallowRef<string>('');
/** Retry of the opening cursor placement; cleared when the editor closes. */
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
const options: Partial<EditorOptions> = {
  onContentError: ({ error }) => {
    loadError.value = String((error as Error & { cause?: unknown }).cause ?? error.message);
  },
  onCreate: ({ editor }) => {
    refreshReview(editor);
    countChapter(editor);
    // A bound doc may render its content just after create; try again once it has.
    if (!placeCursorInBody(editor))
      cursorTimer = setTimeout(() => !editor.isDestroyed && placeCursorInBody(editor));
  },
  onSelectionUpdate: ({ editor }) => countSelection(editor),
  onUpdate: ({ editor }) => {
    refreshReview(editor);
    scheduleCount(editor);
    if (loadError.value) return;
    emit('change', editor.getJSON());
  },
};
// Bind to the raw Y.Doc. A prop can arrive as a Vue reactive proxy (e.g. when the parent's props
// are reactive), and y-sync then registers its observers through the proxy: Yjs reports remote
// changes on the raw types, the identity checks miss, and the view never updates.
const editor = useEditor(
  props.doc
    ? collaborativeEditorOptions(toRaw(props.doc), options)
    : manuscriptEditorOptions({ ...options, content: props.content }),
);
watch(editor, (e) => {
  if (e) {
    refreshReview(e);
    countChapter(e);
  }
});
watch(
  [editor, () => props.readonly || !!loadError.value],
  ([e, ro]) => {
    if (e && e.isEditable === !!ro) e.setEditable(!ro);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  clearTimeout(countTimer);
  stopBook();
  stopChapter();
  clearTimeout(cursorTimer);
  editor.value?.destroy();
});

const LABELS: Record<ReviewItem['type'], string> = {
  comment_anchor: 'Comment',
  suggestion_insert: 'Insert',
  suggestion_delete: 'Delete',
};
</script>

<template>
  <div class="manuscript-editor">
    <p v-if="loadError" class="load-error" role="alert" data-test="load-error">
      This section has content the editor does not support, so it was opened read-only and nothing
      will be saved. {{ loadError }}
      <button type="button" data-test="reload" @click="emit('reload')">Reload section</button>
    </p>
    <EditorToolbar
      v-if="editor"
      :editor="editor"
      :review-open="reviewOpen"
      :navigator-open="props.navigatorOpen"
      :read-only-reason="loadError ? 'document failed to load' : undefined"
      @toggle-navigator="emit('toggle-navigator')"
      @toggle-review="reviewOpen = !reviewOpen"
    />
    <div class="body" :class="{ 'no-review': !reviewOpen }">
      <!-- Auto margins (not justify-center) keep a zoomed page that is wider than the desk
           reachable: it centers when it fits and scrolls from its left edge when it does not. -->
      <div class="desk flex min-w-0 overflow-auto bg-bg" data-test="desk">
        <div
          class="page-sheet box-border mx-auto mt-8 mb-8 h-fit min-h-216 w-144 flex-none bg-paper p-18 text-text shadow-2"
          data-test="page"
          :style="{ zoom: zoom / 100 }"
        >
          <EditorContent :editor="editor" class="page" data-suggester />
        </div>
      </div>
      <div v-if="reviewOpen" class="review" data-test="review">
        <ReviewPanel
          :items="suggestions"
          :filter="filter"
          :current-key="currentKey"
          :collapsed="collapsed"
          :busy="!editor?.isEditable"
          :labels="props.authorLabels"
          @toggle-author="onToggleAuthor"
          @show-all="filter = null"
          @select="select"
          @prev="move(-1)"
          @next="move(1)"
          @decide-one="decideOne"
          @decide-visible="decideVisible"
          @toggle-collapsed="collapsed = !collapsed"
        />
        <section v-if="!collapsed && comments.length" class="comments" aria-label="Comments">
          <h3>Comments</h3>
          <ul>
            <li v-for="r in comments" :key="r.id" data-test="review-item">
              <strong>{{ LABELS[r.type] }}</strong>
              <span v-if="r.author" class="muted"> · {{ r.author }}</span>
              <q>{{ r.text }}</q>
            </li>
          </ul>
        </section>
      </div>
    </div>
    <StatusBar
      v-model:zoom="zoom"
      :chapter-title="chapterTitle"
      :chapter-words="chapterWords"
      :selection-words="selectionWords"
      :book-words="bookWords"
      :save-state="saveState"
    />
  </div>
</template>

<style>
.manuscript-editor .load-error {
  border: 1px solid var(--ct-danger);
  color: var(--ct-danger);
  background: var(--ct-danger-bg);
  padding: 0.5rem 0.75rem;
}
.manuscript-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.manuscript-editor .body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr auto;
}
.manuscript-editor .body.no-review {
  grid-template-columns: 1fr;
}
.manuscript-editor .body > .desk {
  min-height: 0;
}
/* 6x9 in trim (576x864 px at 100%), 72 px margins -> 432 px text block. A rule marks each 864 px
   page height until real pagination lands (RAD-227). */
.manuscript-editor .page-sheet {
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0 863px,
    var(--ct-border) 863px 864px
  );
}
.manuscript-editor .page .tiptap {
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-page);
  line-height: var(--ct-leading-body);
  color: var(--ct-text);
  outline: none;
}
.tiptap p {
  margin: 0;
  text-indent: 1.5em;
}
.tiptap p.p-first,
.tiptap p.p-centered,
.tiptap p.p-epigraph {
  text-indent: 0;
}
.tiptap p.p-block_quote {
  margin: 0.5em 2em;
  text-indent: 0;
}
.tiptap p.p-epigraph {
  margin: 0.5em 3em;
  font-style: italic;
}
.tiptap p.p-verse {
  text-indent: 0;
  padding-left: 2em;
  white-space: pre-wrap;
}
.tiptap p.p-centered {
  text-align: center;
}
.tiptap .scene-break {
  text-align: center;
  margin: 1em 0;
}
.tiptap .page-break {
  border-top: 1px dashed var(--ct-border-strong);
  margin: 1em 0;
}
.smallcaps {
  font-variant: small-caps;
}
.tiptap ins.suggestion-insert {
  color: var(--ct-text);
  background: var(--ct-suggest-insert-bg);
  text-decoration: underline 2px var(--ct-suggest-insert-underline);
  text-underline-offset: 3px;
}
.tiptap del.suggestion-delete {
  color: var(--ct-suggest-delete-text);
  background: var(--ct-suggest-delete-bg);
  text-decoration: line-through 2px var(--ct-suggest-delete-strike);
}
.tiptap .comment-anchor {
  background: var(--ct-comment-bg);
  color: inherit;
}
.manuscript-editor .review {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ct-surface);
}
.manuscript-editor .review > :first-child {
  flex: 1;
}
.manuscript-editor .comments {
  width: 300px;
  box-sizing: border-box;
  padding: var(--ct-space-3);
  border-left: 1px solid var(--ct-border);
  border-top: 1px solid var(--ct-border);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
}
.manuscript-editor .comments ul {
  padding-left: var(--ct-space-4);
}
.manuscript-editor .muted {
  color: var(--ct-text-muted);
}
</style>
