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
import { Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import EditorToolbar from './toolbar/EditorToolbar.vue';
import StatusBar, { type SaveState } from './status/StatusBar.vue';
import { countWords, watchBookWords } from './status/wordcount';
import { agentDirectory, authorLabel, authorName, type AgentName } from './agent-names';
import { loadZoom, saveZoom } from './desk/zoom';
import ReviewPanel from './review/ReviewPanel.vue';
import EmptyState from './shells/EmptyState.vue';
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
  visibleItems,
  type AuthorFilter,
} from './review/review-state';
import FindPanel from './shells/FindPanel.vue';
import ContextMenu from './shells/ContextMenu.vue';
import ShortcutsSheet from './shells/ShortcutsSheet.vue';
import './shells/shells.css';
import {
  collaborativeEditorOptions,
  AuthorLabels,
  collectReviewItems,
  listSuggestions,
  refreshAuthorLabels,
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
  /** Display-only label above the chapter heading ("Chapter Three"); not part of the doc. */
  chapterLabel?: string;
  /** Every section doc of the manuscript, for the live book word count. */
  /** Every section doc in outline order; re-derived from the outline so adds/deletes show. */
  bookDocs?: readonly Y.Doc[];
  /** The chapter's docs (its own and its scenes'); without it only this doc is counted. */
  chapterDocs?: Y.Doc[];
  /** Save status, only when the parent actually knows it. */
  saveState?: SaveState;
  /** Display name for a raw author id in the review panel (decisions still key on the id). */
  authorLabels?: (author: string) => AgentName;
}>();
/** `reload` asks the parent to reopen the section from its source (e.g. by re-mounting). */
const emit = defineEmits<{
  change: [doc: JSONContent];
  reload: [];
  /** The toolbar's chapters toggle; the parent owns the navigator. */
  'toggle-navigator': [];
  /** Human accept/reject decisions as recorded (and withdrawn again on undo). */
  decisions: [records: DecisionRecord[]];
  /** Focus mode (wp5) on or off; the parent hides its own chrome. */
  'focus-mode': [on: boolean];
}>();

/* UI shells for the audit review (Part of #36). Local view state only: none of these change the
   manuscript, the Y.Doc, the selection or the undo history. */
const findOpen = shallowRef(false);
const menuAt = shallowRef<{ x: number; y: number } | null>(null);
const shortcutsOpen = shallowRef(false);
const focusMode = shallowRef(false);
/** Track changes toggle (tc1/tc2): visual state only until suggestion mode is wired. */
const tracking = shallowRef(false);
watch(focusMode, (on) => emit('focus-mode', on));
const isField = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select');
function onShellKey(e: KeyboardEvent) {
  if (isField(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findOpen.value = true;
  } else if (mod && e.key === '/') {
    e.preventDefault();
    shortcutsOpen.value = true;
  } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    focusMode.value = !focusMode.value;
  } else if (e.key === 'Escape' && focusMode.value && !shortcutsOpen.value) {
    focusMode.value = false;
  }
}
function openMenu(e: MouseEvent) {
  menuAt.value = {
    x: Math.min(e.clientX, window.innerWidth - 280),
    y: Math.min(e.clientY, window.innerHeight - 300),
  };
}
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

function onKeydown(ev: KeyboardEvent) {
  const action = reviewActionFor(ev);
  if (!action) return;
  if (action !== 'toggle') {
    // Only while the panel is open and focus is not in some other text field.
    // Same visibility conditions as the panel itself: hidden in focus mode too.
    if (!reviewOpen.value || collapsed.value || focusMode.value) return;
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

const isHeading = (n: PMNode) => n.type.name === 'heading' || n.attrs.style === 'heading';

/** Start of the first body text (not a heading or scene break), or -1 when there is none. */
function firstBodyPos(doc: PMNode): number {
  let target = -1;
  doc.descendants((node, pos) => {
    if (target >= 0) return false;
    if (!node.isTextblock) return true;
    if (!isHeading(node) && node.type.name !== 'scene_break') target = pos + 1;
    return false;
  });
  return target;
}

/**
 * Put the cursor at the start of the first body text, not in the chapter heading, so typing
 * right after opening goes into the prose. Only while the cursor is still at the very start
 * (the author has not moved it), unless `force`; returns whether it moved.
 */
function placeCursorInBody(e: Editor, force = false): boolean {
  const { doc, selection } = e.state;
  if (!force && (!selection.empty || selection.from > 1)) return false;
  const target = firstBodyPos(doc);
  if (target < 0 || (selection.empty && target === selection.from)) return false;
  e.view.dispatch(e.state.tr.setSelection(Selection.near(doc.resolve(target))));
  return true;
}

/**
 * Outline click (#36): focus the editor with the cursor at the start of the first body
 * paragraph. A section with no body (only its heading) gets the cursor at the end of the
 * heading. Only the selection moves: the doc and the undo history are never changed.
 */
function landInBody(e: Editor) {
  if (e.isDestroyed) return;
  const { doc } = e.state;
  let pos = firstBodyPos(doc);
  if (pos < 0) {
    doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (!node.isTextblock) return true;
      if (isHeading(node)) pos = p + 1 + node.content.size;
      return false;
    });
  }
  const sel = pos >= 0 ? Selection.near(doc.resolve(pos)) : Selection.atStart(doc);
  if (!sel.eq(e.state.selection))
    e.view.dispatch(e.state.tr.setSelection(sel).setMeta('addToHistory', false));
  e.view.focus();
}

/** Set by `focusBody` before the editor exists; applied once it is created. */
let focusPending = false;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
/** Focus the editor at the start of the section's body (see `landInBody`). */
function focusBody() {
  const e = editor.value;
  if (!e) {
    focusPending = true;
    return;
  }
  focusPending = false;
  landInBody(e);
  // A bound doc may render its content just after create; land again once it has.
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => landInBody(e));
}
defineExpose({ focusBody });

/** Set when the content does not fit the schema; the editor is then read-only and never emits. */
const loadError = shallowRef<string>('');
/** Retry of the opening cursor placement; cleared when the editor closes. */
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
const options: Partial<EditorOptions> = {
  extensions: [AuthorLabels.configure({ label: authorLabel })],
  onContentError: ({ error }) => {
    loadError.value = String((error as Error & { cause?: unknown }).cause ?? error.message);
  },
  onCreate: ({ editor }) => {
    refreshReview(editor);
    countChapter(editor);
    // A bound doc may render its content just after create; try again once it has.
    if (!placeCursorInBody(editor))
      cursorTimer = setTimeout(() => !editor.isDestroyed && placeCursorInBody(editor));
    if (focusPending) setTimeout(focusBody);
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
// A renamed or removed agent relabels the marks' hover text without touching content.
watch(agentDirectory, () => {
  const e = editor.value;
  if (e && !e.isDestroyed) refreshAuthorLabels(e.view);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  if (focusMode.value) emit('focus-mode', false);
  clearTimeout(countTimer);
  stopBook();
  stopChapter();
  clearTimeout(cursorTimer);
  clearTimeout(focusTimer);
  editor.value?.destroy();
});

const LABELS: Record<ReviewItem['type'], string> = {
  comment_anchor: 'Comment',
  suggestion_insert: 'Insert',
  suggestion_delete: 'Delete',
};
</script>

<template>
  <div
    class="manuscript-editor"
    :class="{ 'focus-mode': focusMode }"
    :data-focus-mode="focusMode || undefined"
    @keydown="onShellKey"
  >
    <p v-if="loadError" class="load-error" role="alert" data-test="load-error">
      This section has content the editor does not support, so it was opened read-only and nothing
      will be saved. {{ loadError }}
      <button type="button" data-test="reload" @click="emit('reload')">Reload section</button>
    </p>
    <EditorToolbar
      v-if="editor && !focusMode"
      :editor="editor"
      :review-open="reviewOpen"
      :navigator-open="props.navigatorOpen"
      :read-only-reason="loadError ? 'document failed to load' : undefined"
      :find-enabled="true"
      @toggle-navigator="emit('toggle-navigator')"
      @toggle-review="reviewOpen = !reviewOpen"
      @find="findOpen = true"
    >
      <template #end>
        <button
          type="button"
          class="sh-track"
          data-test="track-changes"
          :aria-pressed="tracking"
          title="Track changes (preview: not recording yet)"
          @click="tracking = !tracking"
        >
          <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z" />
          </svg>
          Track changes · {{ tracking ? 'On' : 'Off' }}
        </button>
      </template>
      <template #menu>
        <button
          type="button"
          class="sh-tbtn sh-icon"
          data-test="shortcuts-open"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (Ctrl+/)"
          aria-keyshortcuts="Control+/"
          @click="shortcutsOpen = true"
        >
          ?
        </button>
        <button
          type="button"
          class="sh-tbtn"
          data-test="focus-mode"
          title="Focus mode (Ctrl+Shift+F)"
          aria-keyshortcuts="Control+Shift+F"
          @click="focusMode = true"
        >
          Focus
        </button>
      </template>
    </EditorToolbar>
    <div class="body" :class="{ 'no-review': !reviewOpen || focusMode }">
      <!-- Auto margins (not justify-center) keep a zoomed page that is wider than the desk
           reachable: it centers when it fits and scrolls from its left edge when it does not. -->
      <div class="desk relative flex min-w-0 overflow-auto bg-bg" data-test="desk">
        <FindPanel v-if="findOpen && !focusMode" :editor="editor" @close="findOpen = false" />
        <div
          class="page-sheet box-border mx-auto mt-8 mb-8 h-fit min-h-216 w-144 flex-none bg-paper p-18 text-text shadow-2"
          data-test="page"
          :style="{ zoom: zoom / 100 }"
        >
          <p v-if="chapterLabel" class="chapter-label" data-test="chapter-label" aria-hidden="true">
            {{ chapterLabel }}
          </p>
          <EditorContent
            :editor="editor"
            class="page"
            data-suggester
            @contextmenu.prevent="openMenu"
          />
        </div>
        <!-- Margin notes (wp1): suggestion callouts beside the page, read-only. -->
        <div
          v-if="!focusMode && review.some((r) => r.type !== 'comment_anchor')"
          class="sh-margin"
          data-test="margin-notes"
          aria-label="Suggestion notes"
        >
          <div
            v-for="r in review.filter((x) => x.type !== 'comment_anchor')"
            :key="`m-${r.type}-${r.id}`"
            class="sh-callout"
            data-test="margin-note"
          >
            <b
              ><bdi dir="auto">{{ r.author ? authorName(r.author).name : 'Suggestion' }}</bdi></b
            >
            Suggested, not applied. Review to accept.
          </div>
        </div>
      </div>
      <div v-if="reviewOpen && !focusMode" class="review" data-test="review">
        <ReviewPanel
          :items="suggestions"
          :filter="filter"
          :current-key="currentKey"
          :collapsed="collapsed"
          :busy="!editor?.isEditable"
          :labels="props.authorLabels ?? authorName"
          @show-only="(a: string) => (filter = new Set([a]))"
          @show-all="filter = null"
          @select="select"
          @prev="move(-1)"
          @next="move(1)"
          @decide-one="decideOne"
          @decide-visible="decideVisible"
          @toggle-collapsed="collapsed = !collapsed"
        />
        <EmptyState
          v-if="!collapsed && !comments.length"
          class="comments-empty"
          data-test="comments-empty"
          icon="comment"
          title="No comments yet"
          text="Select some text and choose Comment to leave yourself a note."
        />
        <section v-else-if="!collapsed" class="comments" aria-label="Comments">
          <h3>Comments</h3>
          <ul>
            <li v-for="r in comments" :key="r.id" data-test="review-item">
              <strong>{{ LABELS[r.type] }}</strong>
              <span v-if="r.author" class="muted agent-label" data-test="review-author">
                <template v-for="n in [authorName(r.author)]" :key="n.name"
                  >·
                  <bdi class="agent-name" dir="auto" data-test="agent-name" :title="n.name">{{
                    n.name
                  }}</bdi
                  ><span v-if="n.agent" class="agent-tag" data-test="agent-tag">Bot</span>
                  <template v-if="n.note"
                    >{{ ' '
                    }}<span class="agent-note" data-test="agent-note">{{ n.note }}</span></template
                  ></template
                ></span
              >
              <q>{{ r.text }}</q>
            </li>
          </ul>
        </section>
      </div>
    </div>
    <ContextMenu v-if="menuAt" :x="menuAt.x" :y="menuAt.y" @close="menuAt = null" />
    <div
      v-if="menuAt"
      class="fixed inset-0 z-30"
      data-test="context-dismiss"
      @click="menuAt = null"
      @contextmenu.prevent="menuAt = null"
    />
    <ShortcutsSheet v-if="shortcutsOpen" @close="shortcutsOpen = false" />
    <template v-if="focusMode">
      <div class="sh-esc" data-test="focus-pill">
        Focus mode · press <kbd class="sh-kbd">Esc</kbd> to exit
        <button
          type="button"
          class="sh-tbtn sh-icon"
          data-test="focus-exit"
          aria-label="Exit focus mode"
          @click="focusMode = false"
        >
          ×
        </button>
      </div>
      <div class="sh-fwc" data-test="focus-words">
        {{ (chapterWords ?? 0).toLocaleString('en-US') }} words
      </div>
    </template>
    <StatusBar
      v-if="!focusMode"
      v-model:zoom="zoom"
      :chapter-title="chapterTitle"
      :chapter-words="chapterWords"
      :selection-words="selectionWords"
      :book-words="bookWords"
      :save-state="saveState"
    >
      <span v-if="tracking" class="sh-status-track" data-test="status-tracking"
        >Tracking changes</span
      >
    </StatusBar>
  </div>
</template>

<style>
.manuscript-editor .load-error {
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-md);
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
  padding: var(--ct-space-2) var(--ct-space-3);
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
.manuscript-editor .page .tiptap h1 {
  font-family: var(--ct-font-manuscript);
  font-weight: 400;
  text-align: center;
}
.manuscript-editor .chapter-label {
  margin: 0 0 var(--ct-space-2);
  font-family: var(--ct-font-manuscript);
  font-variant: small-caps;
  letter-spacing: 0.18em;
  text-align: center;
  text-transform: lowercase;
  color: var(--ct-text-muted);
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
.manuscript-editor .comments-empty {
  margin-top: var(--ct-space-4);
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
