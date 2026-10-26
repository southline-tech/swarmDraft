<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { DEFAULT_TRIM } from '@coauthor/schema';
import {
  createBackup,
  getAppInfo,
  pickBackupDestination,
  pickBackupToRestore,
  restoreBackup,
  getRecoveryNotices,
  dismissRecoveryNotices,
  type AppInfo,
  type RecoveryNotice,
} from './backend';
import AgentsSettings from './AgentsSettings.vue';
import ManuscriptEditor from './ManuscriptEditor.vue';
import SectionNav from './SectionNav.vue';
import { flushOnClose } from './close-flush';
import {
  importAndOpen,
  reopenLatest,
  UnsavedEditsError,
  type ManuscriptSession,
} from './manuscript-session';

const info = ref<AppInfo | null>(null);
const session = shallowRef<ManuscriptSession | null>(null);
const selectedId = ref<string>();
/** Notices from startup recovery after an interrupted restore; kept until dismissed. */
const recoveryNotices = ref<RecoveryNotice[]>([]);
const recoveryDismissError = ref('');

async function dismissRecovery() {
  try {
    const ids = recoveryNotices.value.map((n) => n.id);
    await dismissRecoveryNotices(ids);
    recoveryNotices.value = recoveryNotices.value.filter((n) => !ids.includes(n.id));
    recoveryDismissError.value = '';
  } catch (e) {
    recoveryDismissError.value = `Couldn't dismiss the notice: ${String(e)}`;
  }
}
const openError = ref('');
/** Persistent: nothing can be opened safely until restart. */
const fatalError = ref('');
const REOPEN_BACKOFF_MS = [250, 500, 1000];
const importing = ref(false);
const saveError = ref('');
/** Shown while edits are unsaved; cleared once a save succeeds. Edits are never dropped. */
const persistHooks = {
  onError: (err: unknown) => (saveError.value = `Not saved, retrying: ${String(err)}`),
  onSaved: () => (saveError.value = ''),
};
/**
 * Bumped by the editor's Reload action to reopen the section from its Y.Doc. The editor is bound
 * to that doc, so everything typed is already in it and survives the remount (and switching
 * sections). The remount is a fresh editor, so its undo history is lost; nothing typed while the
 * editor was read-only after a content error was ever accepted, so there is nothing else to lose.
 */
const reloads = ref(0);
/** The chapter navigator (SectionNav); the toolbar's Chapters button toggles it. */
const navigatorOpen = ref(true);

let stopCloseFlush = () => {};
onMounted(async () => {
  info.value = await getAppInfo();
  if (info.value) {
    try {
      recoveryNotices.value = await getRecoveryNotices();
    } catch {
      recoveryNotices.value = [];
    }
    try {
      const latest = await reopenLatest(persistHooks);
      if (latest && !session.value) open(latest);
    } catch (err) {
      openError.value = `Could not reopen the last manuscript: ${String(err)}`;
    }
  }
  stopCloseFlush = await flushOnClose(() => session.value?.flush() ?? Promise.resolve());
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
    // Save pending edits first so the pre-restore snapshot includes them; if they can't be
    // saved, don't restore (that would lose them).
    try {
      await session.value?.flush();
    } catch (e) {
      backupStatus.value = `Restore cancelled: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`;
      return;
    }
    const r = await restoreBackup(restorePath.value.trim());
    // The restore replaced storage, so the open session's in-memory docs are stale: close them
    // (stops the structure observer and unmounts the editor) so nothing can write them back.
    closeSession();
    backupStatus.value = `Restored. Previous state saved: ${r.preRestoreSnapshot}`;
    tokensNotice.value = r.tokensRevoked > 0 ? r.tokensRevoked : null;
  } catch (e) {
    backupStatus.value = `Restore failed: ${String(e)}`;
  }
}
onBeforeUnmount(() => {
  stopCloseFlush();
  closeQuietly(session.value);
});

/** Close the open manuscript, if any, and clear the selection. */
function closeSession() {
  // Storage was replaced: drop pending edits rather than write them into the restored data.
  void session.value?.close({ discard: true });
  session.value = null;
  selectedId.value = undefined;
}

/** Open an imported manuscript (exposed for tests and the Tauri open-file flow). */
/** A rejected close keeps that session open and retrying; just log it. */
const closeQuietly = (s?: ManuscriptSession | null) =>
  void s?.close().catch((err: unknown) => console.error('Edits not saved yet; retrying', err));

function open(next: ManuscriptSession) {
  if (session.value !== next) closeQuietly(session.value);
  saveError.value = '';
  session.value = next;
  selectedId.value = next.outline.value.find((s) => s.kind === 'chapter')?.id;
}

/** Reopen the newest manuscript with backoff; if that keeps failing, clear the editor for good. */
async function reopenAfterFailure(delays = REOPEN_BACKOFF_MS) {
  for (const ms of [0, ...delays]) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const back = await reopenLatest(persistHooks).catch(() => null);
    if (back) return open(back);
  }
  session.value = null;
  fatalError.value = "Couldn't reopen the manuscript. Please restart coAuthor.";
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  openError.value = '';
  importing.value = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const current = session.value;
    try {
      open(await importAndOpen(bytes, persistHooks, current));
    } catch (err) {
      // The current manuscript was closed but the import failed: never leave the closed session
      // on screen; reopen the newest stored manuscript (the import, if it was written).
      if (current?.closed) await reopenAfterFailure();
      throw err;
    }
  } catch (err) {
    openError.value =
      err instanceof UnsavedEditsError
        ? `Couldn't open ${file.name}: some edits in the current manuscript aren't saved yet`
        : `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    importing.value = false;
    input.value = '';
  }
}

const selected = computed(() =>
  session.value?.outline.value.find((s) => s.id === selectedId.value),
);
const selectedDoc = computed(() =>
  selected.value ? session.value?.sections.get(selected.value.docId) : undefined,
);

defineExpose({ open });
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
      <div v-if="recoveryNotices.length" role="alert" data-test="recovery-notice">
        <p>
          A restore was interrupted. Some attachments may be missing. coAuthor didn't delete
          anything.
        </p>
        <div v-for="(n, i) in recoveryNotices" :key="n.id || i" data-test="recovery-notice-item">
          <p v-if="n.folder && n.moved.length">
            Moved to <code>{{ n.folder }}</code
            >: {{ n.moved.join(', ') }}. To get an attachment back, copy it from that folder into
            <code>{{ n.filesDir }}</code
            >.
          </p>
          <p v-if="n.snapshot">
            Or restore the backup taken just before the restore: <code>{{ n.snapshot }}</code
            >.
          </p>
          <p v-if="n.retryPending">
            coAuthor couldn't finish and will try again the next time it starts.
          </p>
          <p>Details: {{ n.reason }}</p>
          <p v-if="n.corruptFile" data-test="recovery-notice-corrupt">
            An earlier notice couldn't be read. It was kept, not deleted, at
            <code>{{ n.corruptFile }}</code
            >.
          </p>
          <p v-if="n.saveError" data-test="recovery-notice-save-error">
            This notice couldn't be saved and won't show again after you close coAuthor:
            {{ n.saveError }}
          </p>
        </div>
        <button type="button" data-test="recovery-notice-dismiss" @click="dismissRecovery">
          Dismiss
        </button>
        <p v-if="recoveryDismissError">{{ recoveryDismissError }}</p>
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
    <label>
      Import .docx
      <input
        data-test="open-docx"
        type="file"
        accept=".docx"
        :disabled="importing"
        @change="onFile"
      />
    </label>
    <p v-if="fatalError" role="alert" data-test="fatal-error">{{ fatalError }}</p>
    <p v-if="openError" role="alert" data-test="open-error">{{ openError }}</p>
    <p v-if="saveError" role="alert" data-test="save-error">{{ saveError }}</p>
    <p v-if="!session" data-test="no-manuscript">Import a manuscript to see its outline.</p>
    <div
      v-else
      class="workspace grid gap-4"
      :class="navigatorOpen ? 'grid-cols-[18rem_1fr]' : 'grid-cols-1'"
      data-test="workspace"
    >
      <SectionNav
        v-show="navigatorOpen"
        id="chapter-navigator"
        :sections="session.outline.value"
        :manuscript-id="session.id"
        :selected-id="selectedId"
        :save="session.save"
        :locked="session.outlineLocked"
        @select="selectedId = $event"
      />
      <ManuscriptEditor
        v-if="selectedDoc"
        :key="`${selected!.docId}#${reloads}`"
        :doc="selectedDoc"
        :readonly="session.closed"
        :navigator-open="navigatorOpen"
        @reload="reloads++"
        @toggle-navigator="navigatorOpen = !navigatorOpen"
      />
    </div>
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
