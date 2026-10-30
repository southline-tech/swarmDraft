<script setup lang="ts">
/**
 * Designer evidence (#55 / wp5): production ManuscriptEditor in focus mode — no app top bar, outline,
 * review column, toolbar row, or status bar; centred Esc pill and bottom-right word count only.
 */
import type { JSONContent } from '@tiptap/core';
import ManuscriptEditor from '../ManuscriptEditor.vue';

const content: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Chapter Three' }],
    },
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'The Low Tide' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The tide went out the way it always did, slowly and then all at once, leaving the harbor floor bare and shining under a hushed sky. Gulls worked the mud in pairs.',
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Up on the point, the lamp in the old tower was dark, as it had been since March.',
        },
      ],
    },
  ],
};
</script>

<template>
  <main class="shell rad55-evidence" data-test="rad55-focus-evidence">
    <div class="workspace grid grid-cols-1 gap-4 p-4" data-test="workspace">
      <ManuscriptEditor
        :content="content"
        :navigator-open="false"
        navigator-controls="chapter-navigator-rail"
        chapter-title="Harbor dawn"
        :initial-focus-mode="true"
      />
    </div>
  </main>
</template>

<style scoped>
.rad55-evidence :deep(.manuscript-editor) {
  min-height: 0;
  flex: 1;
}
</style>
