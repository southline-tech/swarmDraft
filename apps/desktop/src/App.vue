<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DEFAULT_TRIM } from '@coauthor/schema';
import { getAppInfo, type AppInfo } from './backend';
import AgentsSettings from './AgentsSettings.vue';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './sample';

const info = ref<AppInfo | null>(null);
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
