<script setup lang="ts">
/** Real-component screenshots for #34 (`?evidence=34-install&frame=…`). */
import type { JSONContent } from '@tiptap/core';
import { computed, markRaw, nextTick, onMounted, ref } from 'vue';
import HomeScreen from '../HomeScreen.vue';
import ReviewPanel from '../review/ReviewPanel.vue';
import CommentsPanel from '../comments/CommentsPanel.vue';
import StoryNotesPanel from '../notes/StoryNotesPanel.vue';
import StatusBar from '../status/StatusBar.vue';
import ErrorCard from '../shells/ErrorCard.vue';
import AppLogo from '../AppLogo.vue';
import AppIcon from '../icons/AppIcon.vue';
import SectionNav from '../SectionNav.vue';
import OutlineRail from '../desk/OutlineRail.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import SaveFailureBanner from '../errors/SaveFailureBanner.vue';
import { sampleOutline } from '../fixtures/outline-sample';
import { mapError, saveFailed, SAVE_OK } from '../errors/map-error';
import { createNotesDoc } from '../notes/doc';
import { setAgents } from '../agent-names';
import { readRad34Frame } from './rad34-evidence';

const frame = readRad34Frame(location.search);
const welcomeHost = ref<HTMLElement | null>(null);

const errors = {
  'error-not-word': mapError(new Error('Not a valid .docx (zip directory not found)'), 'import'),
  'error-file-locked': mapError('io: (os error 32)', 'open'),
  'error-file-damaged': mapError(
    new Error('Part word/document.xml checksum mismatch; file is corrupt'),
    'import',
  ),
  'error-disk-full': mapError('io: There is not enough space on the disk. (os error 112)', 'save'),
  'error-save-failed': mapError('weird failure', 'save'),
} as const;

const errorCard = computed(() => {
  if (frame in errors) return errors[frame as keyof typeof errors];
  return null;
});

const notesDoc = markRaw(createNotesDoc());
const outline = [{ id: 'c1', kind: 'chapter' as const, title: 'Sample Chapter', docId: 'd1' }];

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

const saveFailure = saveFailed(SAVE_OK, new Error('io: database is locked'));
const noopCopy = async () => ({ status: 'cancelled' as const });
const c8Content: JSONContent = {
  type: 'doc',
  content: [
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
          text: 'The tide went out slowly, leaving the harbor floor bare under a quiet sky.',
        },
      ],
    },
  ],
};
const c8NavigatorOpen = ref(true);
const c8Sections = ref(sampleOutline());
const c8SelectedId = ref('ch-1');
const c8WorkspaceGridClass = computed(() =>
  c8NavigatorOpen.value ? 'grid-cols-[18rem_1fr]' : 'grid-cols-[var(--ct-rail-w)_1fr]',
);
const c8ChapterNavControls = computed(() =>
  c8NavigatorOpen.value ? 'chapter-navigator' : 'chapter-navigator-rail',
);
function c8NoopSave() {}

onMounted(async () => {
  await nextTick();
  if (frame === 'c5-welcome') {
    welcomeHost.value?.querySelector<HTMLButtonElement>('[data-test="get-started"]')?.focus();
  }
});
</script>

<template>
  <div class="ev34" data-test="evidence-34" :data-frame="frame">
    <div v-if="frame === 'c5-welcome'" ref="welcomeHost" class="ev34__stage">
      <HomeScreen step="welcome" @get-started="() => {}" />
    </div>
    <div v-else-if="frame === 'c7-review-empty'" class="ev34__panel">
      <ReviewPanel :items="[]" :list-items="[]" :follow="false" />
    </div>
    <main
      v-else-if="frame === 'c8-editor-save-failure'"
      class="shell ev34-c8"
      data-test="ev34-c8-editor-shell"
    >
      <header class="topbar">
        <span class="topbar__trigger" aria-hidden="true">
          <AppIcon name="menu" class="topbar__hamburger" />
          <AppLogo :size="24" />
        </span>
        <div class="topbar__brand">
          <span class="topbar__name">The Harbor Ledger</span>
        </div>
      </header>
      <div id="ev34-toolbar-row" class="toolbar-row" data-test="toolbar-row"></div>
      <SaveFailureBanner :state="saveFailure" :save-copy="noopCopy" />
      <div class="workspace grid gap-4 p-4" :class="c8WorkspaceGridClass" data-test="workspace">
        <SectionNav
          v-show="c8NavigatorOpen"
          id="chapter-navigator"
          class="min-h-0 overflow-auto"
          manuscript-id="ev34-c8"
          :sections="c8Sections"
          :selected-id="c8SelectedId"
          :save="c8NoopSave"
          @select="c8SelectedId = $event"
        />
        <OutlineRail v-show="!c8NavigatorOpen" @expand="c8NavigatorOpen = true" />
        <ManuscriptEditor
          :content="c8Content"
          :navigator-open="c8NavigatorOpen"
          :navigator-controls="c8ChapterNavControls"
          chapter-title="Harbor dawn"
          toolbar-target="#ev34-toolbar-row"
          @toggle-navigator="c8NavigatorOpen = !c8NavigatorOpen"
        />
      </div>
    </main>
    <div v-else-if="frame === 'status-saved'" class="ev34__status">
      <StatusBar
        :chapter-count="1"
        :show-chapter-segment="true"
        :word-count="1284"
        :words-before-caret-in-book="0"
        :save="{ phase: 'saved', savedAt: Date.now() }"
        story-notes-panel-id="ev34-notes"
      />
    </div>
    <div v-else-if="errorCard" class="ev34__card">
      <ErrorCard
        :icon="
          frame === 'error-file-locked'
            ? 'lock'
            : frame === 'error-disk-full'
              ? 'disk'
              : frame === 'error-save-failed'
                ? 'save'
                : 'alert'
        "
        :tone="errorCard.tone"
        :title="errorCard.title"
        :text="errorCard.message"
        :action="errorCard.actionLabel"
      />
    </div>
    <div v-else-if="frame === 'empty-comments'" class="ev34__panel">
      <CommentsPanel :threads="[]" />
    </div>
    <div v-else-if="frame === 'empty-notes'" class="ev34__panel">
      <StoryNotesPanel
        :notes-doc="notesDoc"
        :outline="outline"
        :human-author="{ id: 'human:1', name: 'Sample Person' }"
      />
    </div>
  </div>
</template>

<style scoped>
.ev34 {
  box-sizing: border-box;
  min-height: 100vh;
  min-width: 1280px;
  padding: var(--ct-space-4);
  background: var(--ct-bg);
  font-family: var(--ct-font-ui);
  color: var(--ct-text);
}
.ev34__stage {
  min-height: calc(100vh - 2 * var(--ct-space-4));
  display: flex;
}
.ev34__stage :deep(.home) {
  flex: 1;
}
.ev34__panel {
  max-width: 22rem;
  min-height: 28rem;
}
.ev34-c8 {
  min-height: 100vh;
  padding: 0;
  margin: calc(-1 * var(--ct-space-4));
  width: calc(100% + 2 * var(--ct-space-4));
}
.ev34-c8 :deep(.manuscript-editor) {
  min-height: 0;
  flex: 1;
}
.ev34__status {
  margin-top: auto;
  border-top: 1px solid var(--ct-border);
}
.ev34__card {
  max-width: 28rem;
  padding: var(--ct-space-8);
}
</style>
