<script setup lang="ts">
/**
 * Settings → Export (#39): EPUB / .docx jobs for the open manuscript.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { exportApi, exportStatusLabel, type ExportFormat, type ExportJob } from './api';
import { errorLine } from '../errors/map-error';

const props = defineProps<{
  manuscriptId?: string;
  bookTitle?: string;
}>();

const jobs = ref<ExportJob[]>([]);
const busy = ref<ExportFormat | null>(null);
const status = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

const active = computed(() =>
  jobs.value.find((j) => j.status === 'queued' || j.status === 'running'),
);

async function refresh() {
  if (!props.manuscriptId) return;
  const list = await exportApi.list(props.manuscriptId, 8);
  if (list) jobs.value = list;
}

async function start(format: ExportFormat) {
  if (!props.manuscriptId || busy.value) return;
  busy.value = format;
  status.value = '';
  try {
    const job = await exportApi.trigger(props.manuscriptId, format);
    if (!job) {
      status.value = 'Export is only available in the desktop app.';
      return;
    }
    await refresh();
    status.value = 'Export started…';
    const done = await exportApi.wait(job.id, { deadlineMs: 180_000 });
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
