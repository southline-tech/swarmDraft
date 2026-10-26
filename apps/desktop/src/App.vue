<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DEFAULT_TRIM } from '@coauthor/schema';
import {
  createBackup,
  getAppInfo,
  pickBackupDestination,
  pickBackupToRestore,
  restoreBackup,
  takeRecoveryNotice,
  type AppInfo,
  type RecoveryNotice,
} from './backend';
import AgentsSettings from './AgentsSettings.vue';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './sample';
import SectionNav from './SectionNav.vue';
import { SAMPLE_MANUSCRIPT_ID, sampleOutline } from './outline-sample';
import type { Section } from '@coauthor/schema';

const editorKey = ref(0);

const info = ref<AppInfo | null>(null);
const sections = ref<Section[]>(sampleOutline());
const selectedId = ref<string>();
/** One-time notice: startup recovery moved folders aside after an interrupted restore. */
const recoveryNotice = ref<RecoveryNotice | null>(null);

onMounted(async () => {
  info.value = await getAppInfo();
  if (info.value) {
    try {
      recoveryNotice.value = await takeRecoveryNotice();
    } catch {
      recoveryNotice.value = null;
    }
  }
});

const backupStatus = ref('');
const restorePath = ref('');
const confirmingRestore = ref(false);
/** One-time notice after a restore revoked agent tokens; cleared when dismissed. */
const tokensNotice = ref<number | null>(null);

async function chooseRestoreFile(): Promise<void> {
  try {
    const p = await pickBackupToRestore();
    if (p) {
      restorePath.value = p;
      confirmingRestore.value = true;
    }
  } catch (e) {
    backupStatus.value = `Could not open file picker: ${String(e)}`;
  }
}

function askRestore(): void {
  if (restorePath.value.trim()) confirmingRestore.value = true;
}

async function onBackup(): Promise<void> {
  try {
    const dest = await pickBackupDestination();
    if (dest === null) return;
    // The native save dialog already asked the user to confirm Replace for an existing file,
    // so the backend may atomically replace it.
    backupStatus.value = `Backup saved: ${await createBackup(dest, true)}`;
  } catch (e) {
    backupStatus.value = `Backup failed: ${String(e)}`;
  }
}

async function onRestore(): Promise<void> {
  confirmingRestore.value = false;
  if (!restorePath.value.trim()) return;
  try {
    const r = await restoreBackup(restorePath.value.trim());
    backupStatus.value = `Restored. Previous state saved: ${r.preRestoreSnapshot}`;
    tokensNotice.value = r.tokensRevoked > 0 ? r.tokensRevoked : null;
  } catch (e) {
    backupStatus.value = `Restore failed: ${String(e)}`;
  }
}
</script>

<template>
  <main class="shell">
    <h1>coAuthor</h1>
    <p>Default trim: {{ DEFAULT_TRIM }}</p>
    <p v-if="info" data-test="app-info">
      v{{ info.version }} · data: {{ info.dataDir }} · db schema {{ info.schemaVersion }}
    </p>
    <section v-if="info" data-test="backup">
      <button type="button" data-test="backup-button" @click="onBackup">Download backup</button>
      <button type="button" data-test="restore-pick" @click="chooseRestoreFile">
        Restore from backup…
      </button>
      <details data-test="restore-fallback">
        <summary>Enter a path instead</summary>
        <input v-model="restorePath" data-test="restore-path" placeholder="Path to backup .zip" />
        <button type="button" data-test="restore-button" @click="askRestore">Restore…</button>
      </details>
      <div v-if="confirmingRestore" role="alertdialog" data-test="restore-confirm">
        <p data-test="restore-target">{{ restorePath }}</p>
        <p>
          Restoring replaces all manuscripts, comments, suggestions, settings and attached files
          with the contents of this backup, and revokes all agent tokens. Your current state is
          saved first as a pre-restore snapshot in the backups folder.
        </p>
        <button type="button" data-test="restore-confirm-yes" @click="onRestore">
          Replace everything and restore
        </button>
        <button type="button" data-test="restore-confirm-no" @click="confirmingRestore = false">
          Cancel
        </button>
      </div>
      <div v-if="recoveryNotice" role="alert" data-test="recovery-notice">
        <p>
          A restore was interrupted and coAuthor couldn't tell how far it got ({{
            recoveryNotice.reason
          }}). Nothing was deleted: your attachment folders were moved to
          <code>{{ recoveryNotice.folder }}</code
          >.
          <template v-if="recoveryNotice.snapshot">
            Your state before the restore is saved in <code>{{ recoveryNotice.snapshot }}</code
            >.
          </template>
        </p>
        <button type="button" data-test="recovery-notice-dismiss" @click="recoveryNotice = null">
          Dismiss
        </button>
      </div>
      <p v-if="backupStatus" data-test="backup-status">{{ backupStatus }}</p>
      <div v-if="tokensNotice !== null" role="status" data-test="tokens-revoked-notice">
        <p>
          For safety, restoring revoked all {{ tokensNotice }} agent token(s). Your agents are kept;
          create new tokens in Settings → Agents to reconnect them.
        </p>
        <button type="button" data-test="tokens-notice-dismiss" @click="tokensNotice = null">
          Dismiss
        </button>
      </div>
    </section>
    <p v-else data-test="browser-mode">Running in browser mode (no desktop backend).</p>
    <AgentsSettings v-if="info" />
    <SectionNav
      v-model:sections="sections"
      :manuscript-id="SAMPLE_MANUSCRIPT_ID"
      :selected-id="selectedId"
      @select="selectedId = $event"
    />
    <ManuscriptEditor :key="editorKey" :content="SAMPLE_DOC" @reload="editorKey++" />
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
