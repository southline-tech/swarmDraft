<script setup lang="ts">
/**
 * Settings → Export (#39, #186): EPUB / .docx jobs for the open manuscript.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import {
  exportApi,
  exportStatusLabel,
  pandocDownloadStatusLabel,
  type ExportFormat,
  type ExportJob,
} from './api';
import { errorLine } from '../errors/map-error';
import { loadPandocPath, savePandocPath } from '../settings/prefs';

const props = defineProps<{
  manuscriptId?: string;
  bookTitle?: string;
}>();

const jobs = ref<ExportJob[]>([]);
const busy = ref<ExportFormat | null>(null);
const status = ref('');
const pandocPath = ref(loadPandocPath());
let pollTimer: ReturnType<typeof setInterval> | null = null;

const active = computed(() =>
  jobs.value.find((j) => j.status === 'queued' || j.status === 'running'),
);

function persistPandocPath() {
  savePandocPath(pandocPath.value);
}

async function browsePandoc() {
  if (!isTauri()) return;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    title: 'Choose Pandoc',
    multiple: false,
    filters: [{ name: 'Program', extensions: ['exe', ''] }],
  });
  if (typeof picked === 'string' && picked.trim()) {
    pandocPath.value = picked.trim();
    persistPandocPath();
  }
}

async function refresh() {
  if (!props.manuscriptId) return;
  const list = await exportApi.list(props.manuscriptId, 8);
  if (list) jobs.value = list;
}

async function start(format: ExportFormat) {
  if (!props.manuscriptId || busy.value) return;
  busy.value = format;
  status.value = '';
  persistPandocPath();
  try {
    const job = await exportApi.trigger(props.manuscriptId, format, {
      pandocPath: pandocPath.value,
    });
    if (!job) {
      status.value = 'Export is only available in the desktop app.';
      return;
    }
    await refresh();
    status.value = 'Export started…';
    const done = await exportApi.wait(job.id, {
      deadlineMs: 600_000,
      onTick: (_j, pandoc) => {
        if (pandoc?.active) {
          status.value = pandocDownloadStatusLabel(pandoc);
        }
      },
    });
    await refresh();
    if (done) status.value = exportStatusLabel(done);
    else status.value = 'Still working… check again in a moment.';
  } catch (e) {
    status.value = errorLine(e, 'export');
  } finally {
    busy.value = null;
  }
}

watch(
  () => props.manuscriptId,
  () => {
    void refresh();
  },
  { immediate: true },
);

watch(active, (job) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (job) {
    pollTimer = setInterval(() => void refresh(), 800);
  }
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div data-test="export-section">
    <h1 class="st-h1">Export</h1>
    <p class="st-muted st-sub">
      Build a reader-ready EPUB 3 or .docx from the accepted manuscript text (suggestions and
      comments are not included). Files are saved under your swarmDraft data folder.
    </p>
    <p v-if="!manuscriptId" class="st-muted" data-test="export-no-book">
      Open a book to export it.
    </p>
    <template v-else>
      <section class="st-card" :aria-labelledby="'ex-' + manuscriptId">
        <h2 :id="'ex-' + manuscriptId" class="st-h2">
          {{ bookTitle || 'This book' }}
        </h2>
        <p class="st-muted st-desc">PDF print export is coming in a later update.</p>
        <div class="ex__actions">
          <button
            type="button"
            class="st-btn st-btn--primary"
            data-test="export-epub"
            :disabled="!!busy"
            @click="start('epub')"
          >
            Export EPUB
          </button>
          <button
            type="button"
            class="st-btn"
            data-test="export-docx"
            :disabled="!!busy"
            @click="start('docx')"
          >
            Export .docx
          </button>
        </div>
      </section>
      <section class="st-card" aria-labelledby="ex-pandoc-override">
        <h2 id="ex-pandoc-override" class="st-h2">Pandoc</h2>
        <p class="st-muted st-desc">
          On first export, swarmDraft can download Pandoc into your app data folder. To use an
          existing install instead, pick its program here (otherwise PATH is used when present).
        </p>
        <div class="ex__pandoc-row">
          <label class="ex__pandoc-label" for="ex-pandoc-path">Program path (optional)</label>
          <div class="ex__pandoc-controls">
            <input
              id="ex-pandoc-path"
              v-model="pandocPath"
              type="text"
              class="ex__pandoc-input"
              data-test="export-pandoc-path"
              autocomplete="off"
              spellcheck="false"
              placeholder="Leave blank for automatic setup"
              @change="persistPandocPath"
            />
            <button
              type="button"
              class="st-btn"
              data-test="export-pandoc-browse"
              :disabled="!!busy"
              @click="browsePandoc"
            >
              Browse…
            </button>
          </div>
        </div>
      </section>
      <section v-if="jobs.length" class="st-card" aria-labelledby="ex-recent">
        <h2 id="ex-recent" class="st-h2">Recent exports</h2>
        <ul class="ex__list" data-test="export-jobs">
          <li v-for="j in jobs" :key="j.id" class="ex__row">
            <span class="ex__fmt">{{ j.format.toUpperCase() }}</span>
            <span class="ex__state" :data-status="j.status">{{ exportStatusLabel(j) }}</span>
          </li>
        </ul>
      </section>
      <p role="status" class="st-status" data-test="export-status">{{ status }}</p>
    </template>
  </div>
</template>

<style scoped>
.ex__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-3);
}
.ex__pandoc-row {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.ex__pandoc-label {
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.ex__pandoc-controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-3);
  align-items: center;
}
.ex__pandoc-input {
  flex: 1 1 12rem;
  min-width: 0;
  padding: var(--ct-space-2) var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-size: var(--ct-text-sm);
}
.ex__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ex__row {
  display: grid;
  grid-template-columns: 4rem 1fr;
  gap: var(--ct-space-3);
  padding: var(--ct-space-2) 0;
  border-bottom: 1px solid var(--ct-border);
  font-size: var(--ct-text-sm);
}
.ex__row:last-child {
  border-bottom: none;
}
.ex__fmt {
  font-weight: var(--ct-weight-semibold);
  color: var(--ct-text-muted);
}
.ex__state {
  word-break: break-word;
}
</style>
