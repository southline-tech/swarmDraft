<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DEFAULT_TRIM } from '@coauthor/schema';
import { getAppInfo, type AppInfo } from './backend';
import AgentsSettings from './AgentsSettings.vue';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './sample';
import SectionNav from './SectionNav.vue';
import { SAMPLE_MANUSCRIPT_ID, sampleOutline } from './outline-sample';
import type { Section } from '@coauthor/schema';

const info = ref<AppInfo | null>(null);
const sections = ref<Section[]>(sampleOutline());
const selectedId = ref<string>();
onMounted(async () => {
  info.value = await getAppInfo();
});
</script>

<template>
  <main class="shell">
    <h1>coAuthor</h1>
    <p>Default trim: {{ DEFAULT_TRIM }}</p>
    <p v-if="info" data-test="app-info">
      v{{ info.version }} · data: {{ info.dataDir }} · db schema {{ info.schemaVersion }}
    </p>
    <p v-else data-test="browser-mode">Running in browser mode (no desktop backend).</p>
    <AgentsSettings v-if="info" />
    <SectionNav
      v-model:sections="sections"
      :manuscript-id="SAMPLE_MANUSCRIPT_ID"
      :selected-id="selectedId"
      @select="selectedId = $event"
    />
    <ManuscriptEditor :content="SAMPLE_DOC" />
  </main>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
.shell {
  padding: 2rem;
}
</style>
