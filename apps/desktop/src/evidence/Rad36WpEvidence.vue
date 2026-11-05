<script setup lang="ts">
/**
 * PR evidence (#36): real ManuscriptEditor + status bar for find, shortcuts, context menu,
 * and track-changes frames (`?evidence=36-wp&frame=…`).
 */
import type { JSONContent } from '@tiptap/core';
import { ref } from 'vue';
import AppLogo from '../AppLogo.vue';
import AppIcon from '../icons/AppIcon.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { readRad36Frame } from './rad36-evidence';

const frame = readRad36Frame(window.location.search);

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
          text: 'The tide went out slowly, leaving the harbor floor bare under a hushed sky. Gulls worked the mud in pairs while the lamp on the point stayed dark.',
        },
      ],
    },
  ],
};

const initialFindOpen = frame === 'find' || frame === 'find-replace';
const initialFindReplace = frame === 'find-replace';
const initialShortcutsOpen = frame === 'shortcuts';
const initialContextMenu = frame === 'context-menu';
const initialTracking = frame === 'track-on';

const findQuery = frame === 'find' || frame === 'find-replace' ? 'harbor' : undefined;

const chapterTitle = ref('Harbor dawn');
const manuscriptSave = { phase: 'saved' as const, savedAt: Date.now() };
</script>

<template>
  <main class="shell rad36-evidence" data-test="rad36-wp-evidence">
    <header class="topbar">
      <span class="topbar__trigger" aria-hidden="true">
        <AppIcon name="menu" class="topbar__hamburger" />
        <AppLogo :size="24" />
      </span>
      <div class="topbar__brand">
        <span class="topbar__name">The Harbor Ledger</span>
      </div>
    </header>
    <div id="rad36-toolbar" class="toolbar-row" data-test="toolbar-row"></div>
    <div class="workspace grid grid-cols-[18rem_1fr] gap-4 p-4" data-test="workspace">
      <div
        id="chapter-navigator"
        class="min-h-0 overflow-auto rounded-md border border-border bg-surface p-3 text-sm text-muted"
        aria-hidden="true"
      >
        Chapter list (evidence)
      </div>
      <ManuscriptEditor
        :content="content"
        :navigator-open="true"
        navigator-controls="chapter-navigator"
        :chapter-title="chapterTitle"
        toolbar-target="#rad36-toolbar"
        status-target="#rad36-status"
        :initial-find-open="initialFindOpen"
        :initial-find-replace="initialFindReplace"
        :initial-shortcuts-open="initialShortcutsOpen"
        :initial-context-menu="initialContextMenu"
        :initial-tracking="initialTracking"
        :evidence-find-query="findQuery"
        :manuscript-save="manuscriptSave"
      />
    </div>
    <div id="rad36-status" class="shell__status" data-test="rad36-status-slot"></div>
  </main>
</template>

<style scoped>
.rad36-evidence {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.rad36-evidence :deep(.manuscript-editor) {
  min-height: 0;
  flex: 1;
}
</style>
