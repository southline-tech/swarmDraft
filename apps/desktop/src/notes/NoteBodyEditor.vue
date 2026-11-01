<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import type * as Y from 'yjs';
import { collaborativeEditorOptions } from '@swarmdraft/editor';
import { bodyField } from './doc';

const props = defineProps<{
  notesDoc: Y.Doc;
  noteId: string;
  readonly?: boolean;
}>();

const editor = useEditor({
  ...collaborativeEditorOptions(
    props.notesDoc,
    { editable: !props.readonly },
    bodyField(props.noteId),
  ),
  editorProps: {
    attributes: {
      class: 'story-note-body tiptap',
      'data-test': 'note-body',
      'aria-label': 'Body',
    },
  },
});

onBeforeUnmount(() => editor.value?.destroy());
</script>

<template>
  <EditorContent :editor="editor" class="story-note-body-wrap" />
</template>

<style scoped>
.story-note-body-wrap {
  flex: 1;
  min-height: 6rem;
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-paper);
  padding: var(--ct-space-2);
  overflow: auto;
}
.story-note-body-wrap :deep(.tiptap) {
  min-height: 5rem;
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  line-height: var(--ct-leading-body);
  color: var(--ct-text);
}
</style>
