<script setup lang="ts">
/** Toolbar export menu (#245): docx / PDF / Markdown entry points. */
import { ref, shallowRef } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { exportApi } from '../export/api';
import { runBookExport } from '../export/run-book-export';
import { loadPandocPath } from '../settings/prefs';
import AppIcon from '../icons/AppIcon.vue';
import OverlayAnchoredMenu from '../overlay/OverlayAnchoredMenu.vue';
import { useToolbarMenu } from './menu';
import { exportCopy } from '../copy-deck';

const props = defineProps<{
  manuscriptId?: string;
  bookTitle?: string;
}>();

const trigger = shallowRef<HTMLButtonElement | null>(null);
const menuEl = shallowRef<HTMLElement | null>(null);
const { open, wrapEl, close, toggle, onMenuKey } = useToolbarMenu(menuEl, trigger);

const busy = ref(false);
const status = ref('');
const savedPath = ref<string | null>(null);

function setStatus(message: string) {
  status.value = message;
}

async function runDocx() {
  if (!props.manuscriptId || busy.value) return;
  if (!isTauri()) {
    setStatus(exportCopy.desktopOnly);
    close(false);
    return;
  }
  busy.value = true;
  savedPath.value = null;
  close(false);
  try {
    const result = await runBookExport(props.manuscriptId, 'docx', loadPandocPath(), setStatus);
    setStatus(result.status);
    savedPath.value = result.savedPath;
  } finally {
    busy.value = false;
  }
}

function runComingLater(kind: 'pdf' | 'md') {
  if (!props.manuscriptId || busy.value) return;
  savedPath.value = null;
  setStatus(kind === 'pdf' ? exportCopy.pdfLater : exportCopy.markdownLater);
  close(false);
}

async function openSavedFolder() {
  const path = savedPath.value;
  if (!path) return;
  try {
    await exportApi.revealInFolder(path);
  } catch {
    setStatus(exportCopy.couldNotOpenFolder);
  }
}

const btn =
  'inline-flex h-7.5 min-w-7.5 items-center justify-center gap-1.5 rounded-sm border-0 bg-transparent px-2 font-ui text-[13px] font-medium text-text cursor-pointer hover:bg-selected disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ct-focus-ring-color)]';
</script>

<template>
  <div ref="wrapEl" class="relative" @keydown.esc="close()">
    <button
      ref="trigger"
      type="button"
      :class="btn"
      data-test="toolbar-export"
      :aria-label="exportCopy.exportLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      :title="exportCopy.exportManuscriptTitle"
      :disabled="!manuscriptId || busy"
      @click="toggle()"
    >
      {{ exportCopy.exportLabel }}
      <AppIcon name="chevron-down" class="h-4 w-4 opacity-70" aria-hidden="true" />
    </button>
    <OverlayAnchoredMenu :open="open" :trigger="trigger" placement="bottom-end">
      <div
        ref="menuEl"
        role="menu"
        :aria-label="exportCopy.exportFormatsAria"
        data-test="export-menu"
        class="min-w-44 rounded-md border border-border bg-surface p-1.5 shadow-3"
        @keydown="onMenuKey"
      >
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="tb-menu-item"
          data-test="export-docx"
          @click="runDocx()"
        >
          {{ exportCopy.wordManuscript }}
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="tb-menu-item tb-menu-item--soon"
          data-test="export-pdf"
          disabled
          aria-disabled="true"
          :title="exportCopy.pdfLater"
        >
          <span class="tb-menu-item__label">{{ exportCopy.pdfLabel }}</span>
          <span class="tb-menu-item__hint">{{ exportCopy.comingLater }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="tb-menu-item"
          data-test="export-md"
          @click="runComingLater('md')"
        >
          {{ exportCopy.markdownLabel }}
        </button>
      </div>
    </OverlayAnchoredMenu>
    <div v-if="status || savedPath" class="tb-export-feedback">
      <p v-if="status" role="status" class="tb-export-status" data-test="toolbar-export-status">
        {{ status }}
      </p>
      <button
        v-if="savedPath"
        type="button"
        class="tb-export-open"
        data-test="toolbar-export-open-folder"
        @click="openSavedFolder()"
      >
        {{ exportCopy.openFolder }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tb-menu-item {
  display: flex;
  width: 100%;
  min-height: var(--ct-space-8);
  align-items: center;
  padding: 0 var(--ct-space-2);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.tb-menu-item:hover:not(:disabled),
.tb-menu-item:focus-visible:not(:disabled) {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  outline: none;
}
.tb-menu-item--soon {
  justify-content: space-between;
  gap: var(--ct-space-2);
  cursor: default;
  opacity: 0.55;
  color: var(--ct-text-muted);
}
.tb-menu-item__hint {
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
}
.tb-export-feedback {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: var(--ct-z-panel);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--ct-space-1);
  max-width: 16rem;
  margin-top: var(--ct-space-1);
}
.tb-export-status {
  margin: 0;
  padding: var(--ct-space-1) var(--ct-space-2);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  border: 1px solid var(--ct-border);
  color: var(--ct-text-muted);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-xs);
  white-space: normal;
  box-shadow: var(--ct-elevation-3);
}
.tb-export-open {
  padding: var(--ct-space-1) var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-accent);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-xs);
  cursor: pointer;
}
.tb-export-open:hover,
.tb-export-open:focus-visible {
  background: var(--ct-selected-bg);
  outline: none;
}
.tb-export-open:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
</style>
