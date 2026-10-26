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
import type { EditorOptions, JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import EditorToolbar from './toolbar/EditorToolbar.vue';
import ZoomControl from './desk/ZoomControl.vue';
import { loadZoom, saveZoom } from './desk/zoom';
import {
  collaborativeEditorOptions,
  collectReviewItems,
  manuscriptEditorOptions,
  type ReviewItem,
} from '@coauthor/editor';

const props = defineProps<{
  /** The section's Y.Doc to bind to. When set it wins and `content` is ignored. */
  doc?: Y.Doc;
  /** An unbound snapshot, used only when `doc` is not set. */
  content?: JSONContent;
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
/** Set when the content does not fit the schema; the editor is then read-only and never emits. */
const loadError = shallowRef<string>('');
const options: Partial<EditorOptions> = {
  onContentError: ({ error }) => {
    loadError.value = String((error as Error & { cause?: unknown }).cause ?? error.message);
  },
  onCreate: ({ editor }) => (review.value = collectReviewItems(editor.state.doc)),
  onUpdate: ({ editor }) => {
    review.value = collectReviewItems(editor.state.doc);
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
  if (e) review.value = collectReviewItems(e.state.doc);
});
onBeforeUnmount(() => editor.value?.destroy());

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
            <span v-if="r.author" class="muted"> · {{ r.author }}</span>
            <q>{{ r.text }}</q>
          </li>
        </ul>
        <p class="muted">Comments and suggestions are read-only here.</p>
      </aside>
    </div>
    <div
      class="flex h-7 items-center gap-4.5 border-t border-border bg-surface px-3.5 font-ui text-xs text-muted"
      data-test="status-bar"
    >
      <span class="flex-1" />
      <ZoomControl v-model="zoom" />
    </div>
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
  color: #666;
}
</style>
