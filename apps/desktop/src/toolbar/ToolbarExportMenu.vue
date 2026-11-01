<script setup lang="ts">
/** Toolbar export menu (#245): docx / PDF / Markdown entry points. */
import { ref, shallowRef } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { exportApi } from '../export/api';
import { runBookExport } from '../export/run-book-export';
import { loadPandocPath } from '../settings/prefs';
import AppIcon from '../icons/AppIcon.vue';
import { useToolbarMenu } from './menu';

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
    setStatus('Export is only available in the desktop app.');
    close(false);
    return;
  }
  busy.value = true;
  savedPath.value = null;
  close(false);
  try {
    const result = await runBookExport(
      props.manuscriptId,
      'docx',
      loadPandocPath(),
      setStatus,
    );
    setStatus(result.status);
    savedPath.value = result.savedPath;
  } finally {
    busy.value = false;
  }
}

function runComingLater(kind: 'pdf' | 'md') {
  if (!props.manuscriptId || busy.value) return;
  savedPath.value = null;
  setStatus(
    kind === 'pdf'
      ? 'PDF export is coming in a later update.'
      : 'Markdown export is coming in a later update.',
  );
  close(false);
}

async function openSavedFolder() {
  const path = savedPath.value;
  if (!path) return;
  try {
    await exportApi.revealInFolder(path);
  } catch {
    setStatus('Could not open that folder.');
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
      aria-label="Export"
      aria-haspopup="menu"
      :aria-expanded="open"
      title="Export manuscript"
      :disabled="!manuscriptId || busy"
      @click="toggle()"
    >
      Export
      <AppIcon name="chevron-down" class="h-4 w-4 opacity-70" aria-hidden="true" />
    </button>
    <div
      v-show="open"
      ref="menuEl"
      role="menu"
      aria-label="Export formats"
      data-test="export-menu"
      class="absolute top-9 right-0 z-20 min-w-44 rounded-md border border-border bg-surface p-1.5 shadow-3"
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
        Word (.docx)
      </button>
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class="tb-menu-item"
        data-test="export-pdf"
        @click="runComingLater('pdf')"
      >
        PDF
      </button>
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class="tb-menu-item"
        data-test="export-md"
        @click="runComingLater('md')"
      >
        Markdown
      </button>
    </div>
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
        Open folder
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
.tb-menu-item:hover,
.tb-menu-item:focus-visible {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  outline: none;
}
.tb-export-feedback {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 10;
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
  box-shadow: var(--ct-focus-ring);
}
</style>
