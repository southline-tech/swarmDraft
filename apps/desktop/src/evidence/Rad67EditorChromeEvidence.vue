<script setup lang="ts">
/**
 * Designer evidence (#67): production App shell (top bar, toolbar row, workspace grid) with real
 * SectionNav, OutlineRail, and ManuscriptEditor — not shells preview or rad60-only editor.
 */
import type { JSONContent } from '@tiptap/core';
import { computed, ref } from 'vue';
import AppLogo from '../AppLogo.vue';
import AppIcon from '../icons/AppIcon.vue';
import SectionNav from '../SectionNav.vue';
import OutlineRail from '../desk/OutlineRail.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { sampleOutline } from '../fixtures/outline-sample';
import { setAgents } from '../agent-names';
import { readRad67Frame } from './rad67-evidence';
import { saveCollapsed } from '../review/review-state';

const frame = readRad67Frame(window.location.search);
const navigatorOpen = ref(frame !== 'wp2');
if (frame === 'wp2') saveCollapsed(true);
else saveCollapsed(false);

setAgents([
  {
    id: 'a',
    name: 'Mara',
    color: '#c44',
    createdAt: '2026-10-26T00:00:00Z',
    revokedAt: null,
    primary: false,
  },
  {
    id: 'b',
    name: 'Writing assistant',
    color: '#3366ff',
    createdAt: '2026-10-26T00:00:00Z',
    revokedAt: null,
    primary: true,
  },
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
const wp1Content: JSONContent = {
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
          text: 'The tide went out the way it always did, slowly and then all at once, leaving the harbor floor bare and shining under a ',
        },
        {
          type: 'text',
          text: 'very quiet',
          marks: [{ type: 'suggestion_delete', attrs: { id: 'r1', ...by } }],
        },
        {
          type: 'text',
          text: 'hushed',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'r1', ...by } }],
        },
        { type: 'text', text: ' sky. Gulls worked the mud in pairs.' },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Up on the point, the ' },
        {
          type: 'text',
          text: 'lamp',
          marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
        },
        { type: 'text', text: ' in the old tower was dark, as it had been since March.' },
      ],
    },
  ],
};

const wp8Content: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', author: 'agent:a', ts: 't' } }],
          text: 'one',
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's2', author: 'agent:b', ts: 't' } }],
          text: 'two',
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's3', author: 'agent:a', ts: 't' } }],
          text: 'three',
        },
      ],
    },
  ],
};

const editorContent = computed(() => (frame === 'wp8' ? wp8Content : wp1Content));
const suggestionReasons: Readonly<Record<string, string>> =
  frame === 'wp8' ? {} : { r1: 'Matches the date in Chapter 3.' };

const sections = ref(sampleOutline());
const selectedId = ref('ch-1');
const workspaceGridClass = computed(() =>
  navigatorOpen.value ? 'grid-cols-[18rem_1fr]' : 'grid-cols-[var(--ct-rail-w)_1fr]',
);
const chapterNavControls = computed(() =>
  navigatorOpen.value ? 'chapter-navigator' : 'chapter-navigator-rail',
);

function noopSave() {}
</script>

<template>
  <main class="shell rad67-evidence" data-test="rad67-editor-chrome-evidence">
    <header class="topbar">
      <span class="topbar__trigger" aria-hidden="true">
        <AppIcon name="menu" class="topbar__hamburger" />
        <AppLogo :size="24" />
      </span>
      <div class="topbar__brand">
        <span class="topbar__name">The Harbor Ledger</span>
      </div>
    </header>
    <div id="toolbar-row" class="toolbar-row" data-test="toolbar-row" />
    <div class="workspace grid gap-4 p-4" :class="workspaceGridClass" data-test="workspace">
      <SectionNav
        v-show="navigatorOpen"
        id="chapter-navigator"
        class="min-h-0 overflow-auto"
        manuscript-id="rad67-evidence"
        :sections="sections"
        :selected-id="selectedId"
        :save="noopSave"
        @select="selectedId = $event"
      />
      <OutlineRail v-show="!navigatorOpen" @expand="navigatorOpen = true" />
      <ManuscriptEditor
        :content="editorContent"
        :suggestion-reasons="suggestionReasons"
        :navigator-open="navigatorOpen"
        :navigator-controls="chapterNavControls"
        chapter-title="Harbor dawn"
        toolbar-target="#toolbar-row"
        @toggle-navigator="navigatorOpen = !navigatorOpen"
      />
    </div>
  </main>
</template>

<style scoped>
.rad67-evidence :deep(.manuscript-editor) {
  min-height: 0;
  flex: 1;
}
</style>
