<script setup lang="ts">
/**
 * Manuscript editor (RAD-202): Tiptap with the manuscript schema, a paragraph-style toolbar,
 * and a read-only list of the comments and tracked changes in the document.
 */
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import type { JSONContent } from '@tiptap/core';
import {
  PARAGRAPH_STYLES,
  PARAGRAPH_STYLE_LABELS,
  collectReviewItems,
  manuscriptEditorOptions,
  type ParagraphStyle,
  type ReviewItem,
} from '@coauthor/editor';

const props = defineProps<{ content: JSONContent }>();
const emit = defineEmits<{ change: [doc: JSONContent] }>();

const review = shallowRef<ReviewItem[]>([]);
const editor = useEditor(
  manuscriptEditorOptions({
    content: props.content,
    onCreate: ({ editor }) => (review.value = collectReviewItems(editor.state.doc)),
    onUpdate: ({ editor }) => {
      review.value = collectReviewItems(editor.state.doc);
      emit('change', editor.getJSON());
    },
  }),
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
