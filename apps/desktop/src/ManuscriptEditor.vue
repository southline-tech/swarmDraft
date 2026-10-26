<script setup lang="ts">
/**
 * Manuscript editor (RAD-202): Tiptap with the manuscript schema, the formatting toolbar (RAD-254),
 * and a read-only list of the comments and tracked changes in the document.
 *
 * With `doc`, the editor is bound to that section Y.Doc through y-prosemirror
 * (`collaborativeEditorOptions`): every edit is written to the doc as it is typed, and changes
 * from other writers are content-checked before they apply. `content` opens an unbound snapshot.
 */
import { onBeforeUnmount, shallowRef, toRaw, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import type { Editor, EditorOptions, JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import EditorToolbar from './toolbar/EditorToolbar.vue';
import StatusBar, { type SaveState } from './status/StatusBar.vue';
import { countWords, watchBookWords } from './status/wordcount';
import { agentDirectory, authorLabel, authorName } from './agent-names';
import { loadZoom, saveZoom } from './desk/zoom';
import {
  collaborativeEditorOptions,
  AuthorLabels,
  collectReviewItems,
  refreshAuthorLabels,
  manuscriptEditorOptions,
  type ReviewItem,
} from '@coauthor/editor';

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
}>();
/** `reload` asks the parent to reopen the section from its source (e.g. by re-mounting). */
const emit = defineEmits<{
  change: [doc: JSONContent];
  reload: [];
  /** The toolbar's chapters toggle; the parent owns the navigator. */
  'toggle-navigator': [];
}>();
/** Review list visibility, driven by the toolbar's review toggle. */
const reviewOpen = shallowRef(true);

/** Page zoom in percent (RAD-255): scales the 6x9 page without reflowing it, persisted per user. */
const zoom = shallowRef(loadZoom());
watch(zoom, (z) => saveZoom(z));

const review = shallowRef<ReviewItem[]>([]);

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
    review.value = collectReviewItems(editor.state.doc);
    countChapter(editor);
    // A bound doc may render its content just after create; try again once it has.
    if (!placeCursorInBody(editor))
      cursorTimer = setTimeout(() => !editor.isDestroyed && placeCursorInBody(editor));
    if (focusPending) setTimeout(focusBody);
  },
  onSelectionUpdate: ({ editor }) => countSelection(editor),
  onUpdate: ({ editor }) => {
    review.value = collectReviewItems(editor.state.doc);
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
    review.value = collectReviewItems(e.state.doc);
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
          <EditorContent :editor="editor" class="page" />
        </div>
      </div>
      <aside
        v-if="reviewOpen"
        class="review"
        aria-label="Comments and suggestions"
        data-test="review"
      >
        <h3>Review</h3>
        <p v-if="!review.length" class="muted">No comments or suggestions.</p>
        <ul>
          <li
            v-for="r in review"
            :key="`${r.type}--${r.id}`"
            :class="r.type"
            data-test="review-item"
          >
            <strong>{{ LABELS[r.type] }}</strong>
            <span v-if="r.author" class="muted agent-label" data-test="review-author">
              <template v-for="n in [authorName(r.author)]" :key="n.name"
                >·
                <bdi class="agent-name" dir="auto" data-test="agent-name" :title="n.name">{{
                  n.name
                }}</bdi
                ><span v-if="n.agent" class="agent-tag" data-test="agent-tag">Agent</span>
                <template v-if="n.note"
                  >{{ ' '
                  }}<span class="agent-note" data-test="agent-note">{{ n.note }}</span></template
                ></template
              ></span
            >
            <q>{{ r.text }}</q>
          </li>
        </ul>
        <p class="muted">Comments and suggestions are read-only here.</p>
      </aside>
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
  border: 1px solid #b00020;
  color: #b00020;
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
  grid-template-columns: 1fr 16rem;
  gap: 1rem;
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
  color: #1a7f37;
  text-decoration: underline;
}
.tiptap del.suggestion-delete {
  color: #b00020;
}
.tiptap .comment-anchor {
  background: #fff3b0;
}
.manuscript-editor .review ul {
  padding-left: 1rem;
}
.manuscript-editor .muted {
  color: var(--ct-text-muted);
}
</style>
