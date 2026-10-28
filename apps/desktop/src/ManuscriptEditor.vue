<script setup lang="ts">
/**
 * Manuscript editor (RAD-202): Tiptap with the manuscript schema, the formatting toolbar (RAD-254),
 * and a read-only list of the comments and tracked changes in the document.
 *
 * With `doc`, the editor is bound to that section Y.Doc through y-prosemirror
 * (`collaborativeEditorOptions`): every edit is written to the doc as it is typed, and changes
 * from other writers are content-checked before they apply. `content` opens an unbound snapshot.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  toRaw,
  useTemplateRef,
  watch,
} from 'vue';
import { forcedPageNarrow, type EditorLayout } from './desk/outline-auto-collapse';
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
import { SECTION_LOAD_ERROR_COPY } from './errors/map-error';
import type { DocNode } from '@coauthor/schema';
import { useDeferredValue } from './a11y/deferred';

const props = defineProps<{
  /** The section's Y.Doc to bind to. When set it wins and `content` is ignored. */
  doc?: Y.Doc;
  /** An unbound snapshot, used only when `doc` is not set. */
  content?: JSONContent;
  /** No editing (e.g. the session is closed); edits would be dropped. */
  readonly?: boolean;
  /** Toolbar/read-only copy when `readonly` is set by the parent (e.g. RAD-237 restore lock). */
  readOnlyReason?: string;
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
  /** Where the toolbar renders (#84): the parent's full-width row above the side panels. Without
   *  it the toolbar stays inline above the editor body. */
  toolbarTarget?: string;
  /**
   * The parent shows the load error in its own persistent live region (#79); this editor then
   * renders no inline region and reports the error through `load-error` instead.
   */
  externalLoadError?: boolean;
  /** #96: the writer forced the outline open while the review panel shows; the page may then go
   *  down to --ct-page-forced-min-w instead of overflowing the desk. */
  outlineForced?: boolean;
  /** #98: the writer chose "Hide notes" to make room for the outline. */
  notesHidden?: boolean;
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
  /** The current load error ('' when none, and on unmount); for a parent-hosted live region. */
  'load-error': [message: string];
  /** Desk room and review-panel visibility, for the parent's outline auto-collapse (#92). */
  layout: [layout: EditorLayout];
}>();

/* UI shells for the audit review (Part of #36). Local view state only: none of these change the
   manuscript, the Y.Doc, the selection or the undo history. */
const findOpen = shallowRef(false);
const menuAt = shallowRef<{ x: number; y: number } | null>(null);
const shortcutsOpen = shallowRef(false);
const focusMode = shallowRef(false);
/** Track changes toggle (tc1/tc2): visual state only until suggestion mode is wired. */
const tracking = shallowRef(false);
watch(focusMode, (on) => {
  emit('focus-mode', on);
  // #87 QA: focus mode hides the toolbar, so a toolbar button that started it would drop focus
  // to <body>. Move focus into the page, and listen on window for the exit keys while active.
  if (on) {
    window.addEventListener('keydown', onWindowKey);
    void nextTick(() => editor.value?.view.focus());
  } else window.removeEventListener('keydown', onWindowKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKey));
const rootEl = useTemplateRef<HTMLElement>('root');
/** Exit keys for focus mode when focus is outside the editor (e.g. on <body>). Events from inside
    the editor root already reach onShellKey, so they are skipped here to avoid a double toggle. */
function onWindowKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  if (e.target instanceof Node && rootEl.value?.contains(e.target)) return;
  if (isField(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  // An open context menu or Find owns Escape: close it and stay in focus mode (#94).
  if (e.key === 'Escape' && menuAt.value) {
    e.preventDefault();
    menuAt.value = null;
  } else if (e.key === 'Escape' && findOpen.value) {
    e.preventDefault();
    closeFind();
  } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findOpen.value = true;
  } else if (
    (mod && e.shiftKey && e.key.toLowerCase() === 'f') ||
    (e.key === 'Escape' && !shortcutsOpen.value)
  ) {
    e.preventDefault();
    focusMode.value = false;
  }
}
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
  } else if (e.key === 'Escape' && menuAt.value) {
    menuAt.value = null;
  } else if (e.key === 'Escape' && findOpen.value) {
    closeFind();
  } else if (e.key === 'Escape' && focusMode.value && !shortcutsOpen.value) {
    focusMode.value = false;
  }
}
/** Close Find and put focus back in the page, so Escape and the focus-mode keys keep working. */
function closeFind() {
  findOpen.value = false;
  void nextTick(() => editor.value?.view.focus());
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

/* #92: report the desk's width and whether the review panel shows, so the parent can close the
   outline while the page would drop below its minimum width. */
const deskEl = shallowRef<HTMLElement | null>(null);
const deskWidth = shallowRef(0);
const deskLeft = shallowRef(0);
const marginNotesShown = computed(
  () =>
    !focusMode.value && !props.notesHidden && review.value.some((r) => r.type !== 'comment_anchor'),
);
/** #96: page under 440px in the forced state, so it gets the narrower inner padding. */
const pageNarrow = computed(() =>
  forcedPageNarrow(
    !!props.outlineForced && !focusMode.value,
    deskWidth.value,
    marginNotesShown.value,
  ),
);
const layout = computed<EditorLayout>(() => ({
  reviewShown: reviewOpen.value && !collapsed.value && !focusMode.value,
  deskWidth: deskWidth.value,
  marginNotes: marginNotesShown.value,
  deskLeft: deskLeft.value,
  focusMode: focusMode.value,
}));
watch(layout, (l) => emit('layout', l), { immediate: true });
let deskObserver: ResizeObserver | null = null;
onMounted(() => {
  if (!deskEl.value || typeof ResizeObserver === 'undefined') return;
  deskObserver = new ResizeObserver(() => {
    deskWidth.value = deskEl.value?.clientWidth ?? 0;
    deskLeft.value = deskEl.value?.getBoundingClientRect().left ?? 0;
  });
  deskObserver.observe(deskEl.value);
});
onBeforeUnmount(() => deskObserver?.disconnect());

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
// Shown in an always-mounted assertive region one frame after it is set (#79).
const shownLoadError = useDeferredValue(loadError);
watch(loadError, (message) => emit('load-error', message), { immediate: true });
onBeforeUnmount(() => emit('load-error', ''));
/** Retry of the opening cursor placement; cleared when the editor closes. */
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
const options: Partial<EditorOptions> = {
  extensions: [AuthorLabels.configure({ label: authorLabel })],
  onContentError: ({ error }) => {
    const raw = String((error as Error & { cause?: unknown }).cause ?? error.message);
    // Technical detail is for logs only; the banner shows SECTION_LOAD_ERROR_COPY (#89).
    console.warn('section content failed to load:', raw);
    loadError.value = raw;
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
    ref="root"
    class="manuscript-editor"
    :class="{ 'focus-mode': focusMode }"
    :data-focus-mode="focusMode || undefined"
    @keydown="onShellKey"
  >
    <div v-if="!externalLoadError" role="alert" aria-live="assertive" data-test="load-error-region">
      <p v-if="shownLoadError" class="load-error" data-test="load-error">
        {{ SECTION_LOAD_ERROR_COPY }}
        <button type="button" class="sh-btn" data-test="reload" @click="emit('reload')">
          Reload section
        </button>
      </p>
    </div>
    <!-- #84: the toolbar moves to the parent's full-width row; its own keydown keeps the editor
         shortcuts (Ctrl+F, Ctrl+/) working from toolbar focus, since teleported DOM no longer
         sits inside .manuscript-editor. -->
    <Teleport :to="props.toolbarTarget" :disabled="!props.toolbarTarget" defer>
      <div
        v-if="editor && !focusMode"
        class="toolbar-host"
        @keydown="props.toolbarTarget ? onShellKey($event) : undefined"
      >
        <EditorToolbar
          v-if="editor && !focusMode"
          :editor="editor"
          :review-open="reviewOpen"
          :navigator-open="props.navigatorOpen"
          :read-only-reason="
            loadError ? 'document failed to load' : props.readOnlyReason || undefined
          "
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
      </div>
    </Teleport>
    <div class="body" :class="{ 'no-review': !reviewOpen || focusMode }">
      <!-- Auto margins (not justify-center) keep a zoomed page that is wider than the desk
           reachable: it centers when it fits and scrolls from its left edge when it does not. -->
      <div
        ref="deskEl"
        class="desk relative flex min-w-0 overflow-auto bg-bg"
        :class="{ 'desk--outline-forced': outlineForced }"
        data-test="desk"
      >
        <FindPanel v-if="findOpen" :editor="editor" @close="closeFind" />
        <div
          :class="{ 'page-sheet--narrow': pageNarrow }"
          class="page-sheet box-border mx-auto mt-8 mb-8 h-fit min-h-216 flex-none bg-paper p-18 text-text shadow-2"
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
          v-if="marginNotesShown"
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
      <div
        v-if="reviewOpen && !focusMode"
        class="review"
        :class="{ 'review--collapsed': collapsed }"
        data-test="review"
      >
        <ReviewPanel
          :items="suggestions"
          :load-failed="!!loadError"
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
          v-if="!collapsed && !comments.length && !loadError"
          class="comments-empty"
          data-test="comments-empty"
          icon="comment"
          title="No comments yet"
          text="Select some text and choose Comment to leave yourself a note."
        />
        <section v-else-if="!collapsed && comments.length" class="comments" aria-label="Comments">
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
.manuscript-editor .load-error,
.editor-error-region .load-error {
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
   page height until real pagination lands (RAD-227).
   #92: on a narrow desk the page narrows with it, min(576px, desk minus the side gutters and any
   margin notes), never below 440px. The parent closes the outline before it would go lower. */
.manuscript-editor .page-sheet {
  width: max(
    var(--ct-page-min-w),
    min(var(--ct-page-w), 100% - 2 * var(--ct-page-gutter) - var(--ct-page-notes-room))
  );
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0 863px,
    var(--ct-border) 863px 864px
  );
}
/* #96: the writer forced the outline open on a narrow desk. The page may shrink to 320px so it
   never overflows the desk; the 24px gutters stay, so text never touches the review panel. */
.manuscript-editor .desk--outline-forced .page-sheet {
  width: clamp(
    var(--ct-page-forced-min-w),
    100% - 2 * var(--ct-page-gutter) - var(--ct-page-notes-room),
    var(--ct-page-w)
  );
}
.manuscript-editor .page-sheet.page-sheet--narrow {
  padding-left: var(--ct-space-8);
  padding-right: var(--ct-space-8);
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
.manuscript-editor .desk:has(> .sh-margin) {
  --ct-page-notes-room: calc(var(--ct-margin-notes-w) + var(--ct-space-4));
}
/* #97: like the page, a note card never touches the review panel. */
.manuscript-editor .desk > .sh-margin {
  margin-right: var(--ct-space-4);
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
/* #90: the open review column has a fixed width (400px; 320px below 1200px), so its contents
   (e.g. the comments empty state) can't widen it over the page. The desk keeps the rest and
   scrolls the page, which never sits under a panel. The collapsed rail keeps its own width.
   #92: it never narrows below --ct-panel-w-narrow to make room for the page. */
.manuscript-editor .review:not(.review--collapsed) {
  box-sizing: border-box;
  width: var(--ct-panel-w);
  min-width: var(--ct-panel-w-narrow);
}
.manuscript-editor .review:not(.review--collapsed) > * {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
}
@media (max-width: 1199.98px) {
  .manuscript-editor .review:not(.review--collapsed) {
    width: var(--ct-panel-w-narrow);
  }
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
