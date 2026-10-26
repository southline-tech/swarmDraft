<script setup lang="ts">
/**
 * Manuscript editor (RAD-202): Tiptap with the manuscript schema, a paragraph-style toolbar,
 * and a read-only list of the comments and tracked changes in the document.
 *
 * With `doc`, the editor is bound to that section Y.Doc through y-prosemirror
 * (`collaborativeEditorOptions`): every edit is written to the doc as it is typed, and changes
 * from other writers are content-checked before they apply. `content` opens an unbound snapshot.
 */
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import type { EditorOptions, JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import {
  PARAGRAPH_STYLES,
  PARAGRAPH_STYLE_LABELS,
  collaborativeEditorOptions,
  collectReviewItems,
  manuscriptEditorOptions,
  type ParagraphStyle,
  type ReviewItem,
} from '@coauthor/editor';

const props = defineProps<{ doc?: Y.Doc; content?: JSONContent }>();
/** `reload` asks the parent to reopen the section from its source (e.g. by re-mounting). */
const emit = defineEmits<{ change: [doc: JSONContent]; reload: [] }>();

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
const editor = useEditor(
  props.doc
    ? collaborativeEditorOptions(props.doc, options)
    : manuscriptEditorOptions({ ...options, content: props.content }),
);
watch(editor, (e) => {
  if (e) review.value = collectReviewItems(e.state.doc);
});
onBeforeUnmount(() => editor.value?.destroy());

const currentStyle = computed<ParagraphStyle | ''>(() => {
  const e = editor.value;
  if (!e || !e.isActive('paragraph')) return '';
  return (e.getAttributes('paragraph').style as ParagraphStyle) ?? 'body';
});

function setStyle(ev: Event) {
  editor.value
    ?.chain()
    .focus()
    .setParagraphStyle((ev.target as HTMLSelectElement).value as ParagraphStyle)
    .run();
}

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
    <div v-if="editor" class="toolbar" role="toolbar" aria-label="Formatting">
      <select
        data-test="paragraph-style"
        aria-label="Paragraph style"
        :value="currentStyle"
        :disabled="!currentStyle"
        @change="setStyle"
      >
        <option v-for="s in PARAGRAPH_STYLES" :key="s" :value="s">
          {{ PARAGRAPH_STYLE_LABELS[s] }}
        </option>
      </select>
      <button
        type="button"
        title="Bold (Ctrl+B)"
        :aria-pressed="editor.isActive('bold')"
        @click="editor.chain().focus().toggleBold().run()"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        title="Italic (Ctrl+I)"
        :aria-pressed="editor.isActive('italic')"
        @click="editor.chain().focus().toggleItalic().run()"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        title="Small caps"
        :aria-pressed="editor.isActive('smallcaps')"
        @click="editor.chain().focus().toggleSmallcaps().run()"
      >
        <span class="smallcaps">Sc</span>
      </button>
      <button
        type="button"
        data-test="scene-break"
        title="Scene break (type *** on its own line)"
        @click="editor.chain().focus().insertSceneBreak().run()"
      >
        ***
      </button>
      <button
        type="button"
        title="Page break"
        @click="editor.chain().focus().insertPageBreak().run()"
      >
        Page break
      </button>
    </div>
    <div class="body">
      <EditorContent :editor="editor" class="page" />
      <aside class="review" aria-label="Comments and suggestions" data-test="review">
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
  </div>
</template>

<style>
.manuscript-editor .load-error {
  border: 1px solid #b00020;
  color: #b00020;
  padding: 0.5rem 0.75rem;
}
.manuscript-editor .toolbar {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem 0;
  border-bottom: 1px solid #ddd;
}
.manuscript-editor button[aria-pressed='true'] {
  background: #dde6ff;
}
.manuscript-editor .body {
  display: grid;
  grid-template-columns: 1fr 16rem;
  gap: 1rem;
}
.manuscript-editor .page .tiptap {
  font-family: Georgia, serif;
  line-height: 1.6;
  max-width: 36rem;
  padding: 1rem;
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
  border-top: 1px dashed #999;
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
