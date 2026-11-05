<script setup lang="ts">
/** Release checklist screenshots (#34 / #41): real components @ 1280×800 (`?evidence=34-41&frame=…`). */
import type { JSONContent } from '@tiptap/core';
import { computed, nextTick, onMounted, provide, ref, shallowRef } from 'vue';
import type { AgentsApi } from '../backend';
import AgentsSettings from '../AgentsSettings.vue';
import AppIcon from '../icons/AppIcon.vue';
import AppLogo from '../AppLogo.vue';
import CommentsPanel from '../comments/CommentsPanel.vue';
import ExportSection from '../export/ExportSection.vue';
import HomeScreen from '../HomeScreen.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import ReviewPanel from '../review/ReviewPanel.vue';
import ErrorCard from '../shells/ErrorCard.vue';
import OpeningProgress from '../shells/OpeningProgress.vue';
import StatusBar from '../status/StatusBar.vue';
import UpdatePromptToast from '../updater/UpdatePromptToast.vue';
import { mapError } from '../errors/map-error';
import { APP_FOOTER_EDITOR_KEY } from '../status/app-footer';
import { readRad3441Frame } from './rad3441-evidence';
import '../settings/settings.css';
import '../shells/shells.css';

const frame = readRad3441Frame(location.search);
const welcomeHost = ref<HTMLElement | null>(null);

const openingError = mapError(new Error('not a valid .docx (zip directory not found)'), 'import');

const editorContent: JSONContent = {
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

const navigatorOpen = ref(true);
const manuscriptSave = { phase: 'saved' as const, savedAt: Date.now() };
const footerTracks = '18rem minmax(0, 1fr) auto';
provide(APP_FOOTER_EDITOR_KEY, shallowRef({}));

const agentsApiStub: AgentsApi = {
  list: async () => [
    {
      id: 'a1',
      name: 'Writing assistant',
      color: '#3366ff',
      createdAt: '2026-10-26T00:00:00Z',
      revokedAt: null,
      primary: true,
      lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
    },
  ],
  primaryId: async () => 'a1',
  create: async () => {
    throw new Error('evidence stub');
  },
  setUserDisplayName: async (n) => n,
  revoke: async () => {},
  tokens: async () => [],
  createToken: async () => {
    throw new Error('evidence stub');
  },
  revokeToken: async () => {},
  draftAccessList: async () => [],
  setDraftAccessMode: async () => {},
  grantDraft: async () => {},
  revokeDraft: async () => {},
  bulkGrantCurrentDraft: async () => {},
  bulkGrantAllDrafts: async () => {},
  bulkRevokeAllDrafts: async () => {},
};

const agentsNow = () => Date.now();

const showDeskChrome = computed(
  () =>
    frame === 'editor' ||
    frame === 'save-status' ||
    frame === 'error-card' ||
    frame === 'empty-states',
);

onMounted(async () => {
  await nextTick();
  if (frame === 'welcome') {
    welcomeHost.value?.querySelector<HTMLButtonElement>('[data-test="get-started"]')?.focus();
  }
});
</script>

<template>
  <div class="ev3441" data-test="evidence-3441" :data-frame="frame">
    <div v-if="frame === 'welcome'" ref="welcomeHost" class="ev3441__stage">
      <HomeScreen step="welcome" @get-started="() => {}" />
    </div>
    <div v-else-if="frame === 'import'" class="ev3441__stage">
      <HomeScreen step="open" @choose="() => {}" @drop-file="() => {}" />
    </div>
    <div v-else-if="frame === 'opening-progress'" class="ev3441__stage ev3441__stage--center">
      <OpeningProgress
        title="Harbor Ledger"
        :found="42"
        :progress="0.38"
        kind="import"
        :cancellable="true"
      />
    </div>
    <div v-else-if="frame === 'update-prompt'" class="ev3441__update-shell">
      <header class="topbar">
        <span class="topbar__trigger" aria-hidden="true">
          <AppIcon name="menu" class="topbar__hamburger" />
          <AppLogo :size="24" />
        </span>
        <div class="topbar__brand">
          <span class="topbar__name">The Harbor Ledger</span>
        </div>
      </header>
      <div class="ev3441__update-desk" aria-hidden="true" />
      <div class="ev3441__update-wrap">
        <UpdatePromptToast
          mode="available"
          version="0.2.0"
          :progress="null"
          :manual-message="null"
        />
      </div>
    </div>
    <main v-else-if="showDeskChrome" class="ev3441__desk shell">
      <div class="shell__main">
        <header class="topbar">
          <span class="topbar__trigger" aria-hidden="true">
            <AppIcon name="menu" class="topbar__hamburger" />
            <AppLogo :size="24" />
          </span>
          <div class="topbar__brand">
            <span class="topbar__name">The Harbor Ledger</span>
          </div>
        </header>
        <div id="ev3441-toolbar" class="toolbar-row" data-test="toolbar-row"></div>
        <div class="shell__desk min-h-0 flex flex-1 flex-col overflow-hidden">
          <div
            v-if="frame === 'error-card'"
            class="opening-shell opening-shell--overlay"
            data-test="opening-shell"
          >
            <ErrorCard
              autofocus
              icon="alert"
              :tone="openingError.tone"
              :title="openingError.title"
              :text="openingError.message"
              :action="openingError.actionLabel"
              dismissible
            />
          </div>
          <div
            v-else-if="frame === 'empty-states'"
            class="workspace grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)] gap-4 p-4"
            data-test="empty-states-pair"
          >
            <div
              id="chapter-navigator"
              class="min-h-0 overflow-auto rounded-md border border-border bg-surface p-3 text-sm text-muted"
              aria-hidden="true"
            >
              Chapter list
            </div>
            <div class="grid min-h-0 grid-cols-2 gap-4">
              <ReviewPanel :items="[]" :list-items="[]" :follow="false" />
              <CommentsPanel :threads="[]" />
            </div>
          </div>
          <div
            v-else
            class="workspace grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)] gap-4 p-4"
            data-test="workspace"
          >
            <div
              id="chapter-navigator"
              class="min-h-0 overflow-auto rounded-md border border-border bg-surface p-3 text-sm text-muted"
              aria-hidden="true"
            >
              Chapter list
            </div>
            <ManuscriptEditor
              v-if="frame === 'editor'"
              :content="editorContent"
              :navigator-open="navigatorOpen"
              navigator-controls="chapter-navigator"
              chapter-title="Harbor dawn"
              toolbar-target="#ev3441-toolbar"
              :manuscript-save="manuscriptSave"
            />
            <div
              v-else
              class="ev3441__editor-placeholder"
              data-test="editor-placeholder"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <StatusBar
        v-if="frame === 'save-status' || frame === 'editor'"
        class="shell__status"
        :chapter-count="1"
        :show-chapter-segment="navigatorOpen"
        :column-tracks="footerTracks"
        :word-count="1234"
        :words-before-caret-in-book="612"
        :track-changes="false"
        :save="manuscriptSave"
        story-notes-panel-id="story-notes-panel"
        :story-notes-open="false"
        :zoom="100"
      />
    </main>
    <div v-else-if="frame === 'export-settings'" class="ev3441__settings">
      <ExportSection manuscript-id="ev3441-export" book-title="The Harbor Ledger" />
    </div>
    <div v-else-if="frame === 'agents'" class="ev3441__settings">
      <AgentsSettings :api="agentsApiStub" :now="agentsNow" />
    </div>
  </div>
</template>

<style scoped>
.ev3441 {
  box-sizing: border-box;
  min-height: 100vh;
  min-width: 1280px;
  background: var(--ct-bg);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.ev3441__stage {
  min-height: 100vh;
  display: flex;
}
.ev3441__stage :deep(.home) {
  flex: 1;
}
.ev3441__stage--center {
  align-items: center;
  justify-content: center;
  padding: var(--ct-space-8);
}
.ev3441__desk {
  min-height: 100vh;
  max-height: 100vh;
}
.ev3441__desk :deep(.manuscript-editor) {
  min-height: 0;
  flex: 1;
}
.ev3441__editor-placeholder {
  min-height: 12rem;
  border: 1px dashed var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
}
.ev3441__empty :deep(.review-panel),
.ev3441__empty :deep(.comments-panel) {
  min-height: 20rem;
}
.ev3441__settings {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--ct-space-8) var(--ct-space-16) var(--ct-space-12);
}
.ev3441__update-shell {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--ct-bg);
}
.ev3441__update-desk {
  flex: 1;
  background: var(--ct-bg);
}
.ev3441__update-wrap {
  position: fixed;
  top: var(--ct-space-12);
  right: var(--ct-space-6);
  z-index: var(--ct-z-toast);
}
.topbar {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  height: var(--ct-space-10);
  padding: 0 var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-surface);
}
.topbar__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-2);
}
.topbar__hamburger {
  width: 1.25rem;
  height: 1.25rem;
}
.topbar__name {
  font-weight: var(--ct-weight-semibold);
}
.opening-shell {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ct-space-8);
}
.opening-shell--overlay {
  position: absolute;
  inset: 0;
  z-index: var(--ct-z-overlay);
  background: var(--ct-scrim);
}
.toolbar-row {
  flex: none;
  min-height: 2.75rem;
  background: var(--ct-surface);
}
.shell__desk {
  position: relative;
  min-height: 0;
}
</style>
