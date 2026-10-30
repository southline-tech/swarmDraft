<script setup lang="ts">
/** Designer evidence (#60): real ReviewPanel via ManuscriptEditor, not shells preview. */
import type { JSONContent } from '@tiptap/core';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { setAgents } from '../agent-names';

setAgents([
  {
    id: 'demo',
    name: 'Writing assistant',
    color: '#3366ff',
    createdAt: '2026-10-26T00:00:00Z',
    revokedAt: null,
    primary: true,
  },
]);

const by = { author: 'agent:demo', ts: '2026-10-26T00:00:00Z' };
const content: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The ledger had been kept for ' },
        {
          type: 'text',
          text: 'forty-one',
          marks: [{ type: 'suggestion_delete', attrs: { id: 'r1', ...by } }],
        },
        {
          type: 'text',
          text: 'forty',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'r1', ...by } }],
        },
        { type: 'text', text: ' years.' },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'guttered',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'r2', ...by } }],
        },
      ],
    },
  ],
};

const suggestionReasons = {
  r1: 'Matches the date in Chapter 3.',
  r2: `${'Stronger verb. '.repeat(12)}`.trim(),
};
</script>

<template>
  <div class="rad60-evidence" data-test="rad60-review-evidence">
    <ManuscriptEditor :content="content" :suggestion-reasons="suggestionReasons" />
  </div>
</template>

<style scoped>
.rad60-evidence {
  height: 100vh;
  min-height: 0;
  display: flex;
  background: var(--ct-bg);
}
.rad60-evidence :deep(.manuscript-editor) {
  flex: 1;
  min-height: 0;
}
</style>
