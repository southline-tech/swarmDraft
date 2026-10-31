<script setup lang="ts">
/** Designer evidence for #38 story notes (`?evidence=38-notes&frame=empty|filled`). */
import { computed, markRaw } from 'vue';
import * as Y from 'yjs';
import StoryNotesPanel from '../notes/StoryNotesPanel.vue';
import { addNote, createNotesDoc } from '../notes/doc';
import { readRad38Frame } from './rad38-evidence';

const frame = readRad38Frame(location.search);
const notesDoc = markRaw(createNotesDoc());
if (frame === 'filled') {
  addNote(notesDoc, { kind: 'human', id: 'human:1', name: 'Sample Person' }, 'Opening hook');
  addNote(notesDoc, { kind: 'agent', id: 'agent:bot', name: 'Sample Bot' }, 'Timeline check');
  addNote(notesDoc, { kind: 'agent', id: 'agent:bot', name: 'Sample Bot' }, 'Continuity');
}

const outline = [
  { id: 'fm', kind: 'front_matter' as const, title: 'Dedication', docId: 'd0' },
  { id: 'c1', kind: 'chapter' as const, title: 'Sample Chapter One', docId: 'd1' },
];

const label = computed(() =>
  frame === 'filled' ? 'Story notes with human and bot entries' : 'Empty story notes',
);
</script>

<template>
  <div class="ev38" data-test="evidence-38">
    <p class="ev38__cap">{{ label }}</p>
    <StoryNotesPanel
      :notes-doc="notesDoc"
      :outline="outline"
      :human-author="{ id: 'human:1', name: 'Sample Person' }"
    />
  </div>
</template>

<style scoped>
.ev38 {
  box-sizing: border-box;
  min-height: 100vh;
  padding: var(--ct-space-4);
  background: var(--ct-bg);
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.ev38__cap {
  margin: 0;
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.ev38 :deep(.story-notes) {
  max-width: 22rem;
  min-height: 32rem;
}
</style>
