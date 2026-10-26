<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
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
import { refreshAgents, reloadOnFocus } from './agent-names';
import ManuscriptEditor from './ManuscriptEditor.vue';
import SectionNav from './SectionNav.vue';
import HomeScreen from './HomeScreen.vue';
import { flushOnClose } from './close-flush';
import { docWordCount, outlineDocs, sectionTreeDocs } from './status/wordcount';
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

/** First-run welcome (ob4) shows once; the flag survives restarts and updates. */
const WELCOMED_KEY = 'coauthor.welcomed';
const welcomed = ref(readWelcomed());
function readWelcomed(): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOMED_KEY) === '1';
  } catch {
    return false;
  }
}
function markWelcomed() {
  welcomed.value = true;
  try {
    globalThis.localStorage?.setItem(WELCOMED_KEY, '1');
  } catch {
    // Storage unavailable: the welcome just shows again next launch.
  }
}
const home = ref<InstanceType<typeof HomeScreen> | null>(null);
async function getStarted() {
  markWelcomed();
  await nextTick();
  await home.value?.focusOpen();
}
/** "Open another book" from inside an open manuscript shows the open screen over it. */
const choosingBook = ref(false);
const settingsOpen = ref(false);
const settingsPanel = ref<HTMLElement | null>(null);
const settingsButton = ref<HTMLButtonElement | null>(null);
watch(settingsOpen, async (isOpen) => {
  await nextTick();
  // Into the panel on open; back to the button that opened it on close.
  if (isOpen) settingsPanel.value?.focus();
  else settingsButton.value?.focus();
});
const fileInput = ref<HTMLInputElement | null>(null);
const chooseFile = () => fileInput.value?.click();

let stopCloseFlush = () => {};
/**
 * With Tauri's drag-drop off, the webview's default for a file dropped anywhere
 * is to navigate to it, unloading the app. Swallow that at window level; the
 * drop zone and Chapters list still handle their own drops (they run first).
 */
function blockFileNavigation(e: DragEvent) {
  e.preventDefault();
}
// Agent display names (RAD-263): load once, and again when the window regains focus.
const reloadAgents = () => void reloadOnFocus();
onMounted(() => {
  window.addEventListener('dragover', blockFileNavigation);
  window.addEventListener('drop', blockFileNavigation);
  window.addEventListener('focus', reloadAgents);
  void refreshAgents();
});
onBeforeUnmount(() => {
  window.removeEventListener('dragover', blockFileNavigation);
  window.removeEventListener('drop', blockFileNavigation);
  window.removeEventListener('focus', reloadAgents);
});
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
  choosingBook.value = false;
}

/** Open an imported manuscript (exposed for tests and the Tauri open-file flow). */
/** A rejected close keeps that session open and retrying; just log it. */
const closeQuietly = (s?: ManuscriptSession | null) =>
  void s?.close().catch((err: unknown) => console.error('Edits not saved yet; retrying', err));

function open(next: ManuscriptSession) {
  if (session.value !== next) closeQuietly(session.value);
  saveError.value = '';
  // A manuscript is open again, so an earlier "please restart" or open failure no longer holds.
  fatalError.value = '';
  openError.value = '';
  // Anyone with a book open is past first run: never flash the welcome at them.
  markWelcomed();
  choosingBook.value = false;
  session.value = next;
  // Open where the prose starts: an imported chapter's doc often holds only its heading and the
  // text lives in its scenes, so prefer the first chapter's first scene (#25 QA: typing right
  // after opening went into the heading).
  const rows = next.outline.value;
  const chapter = rows.find((s) => s.kind === 'chapter');
  selectedId.value = chapter
    ? (rows.find((s) => s.kind === 'scene' && s.parentId === chapter.id) ?? chapter).id
    : undefined;
}

/**
 * Reopen the newest manuscript with backoff; if that keeps failing, clear the editor for good.
 * Returns the reopened session, or null.
 */
async function reopenAfterFailure(delays = REOPEN_BACKOFF_MS): Promise<ManuscriptSession | null> {
  for (const ms of [0, ...delays]) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const back = await reopenLatest(persistHooks).catch(() => null);
    if (back) {
      open(back);
      return back;
    }
  }
  session.value = null;
  fatalError.value = "Couldn't reopen the manuscript. Please restart coAuthor.";
  return null;
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await importFile(file);
  } finally {
    input.value = '';
  }
}

/** Word manuscripts only; checked before anything (including the open book) is touched. */
const NOT_WORD_FILE = "That file isn't a Word manuscript. Please choose a Word file.";
const isWordFile = (f: File) => f.name.toLowerCase().endsWith('.docx');

async function importFile(file: File) {
  if (importing.value) return;
  if (!isWordFile(file)) {
    openError.value = NOT_WORD_FILE;
    return;
  }
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
      // A refused close keeps the current manuscript on screen: keep following agent writes.
      if (current && !current.closed && session.value === current) current.resumeLive?.();
      if (current?.closed) {
        const back = await reopenAfterFailure();
        // The newest manuscript is not the one we closed, so the import was saved and is now
        // open: the import worked and there is nothing to report.
        if (back && back.id !== current.id) return;
      }
      throw err;
    }
  } catch (err) {
    openError.value =
      err instanceof UnsavedEditsError
        ? `Couldn't open ${file.name}: some edits in the current manuscript aren't saved yet`
        : `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    importing.value = false;
  }
}

const selected = computed(() =>
  session.value?.outline.value.find((s) => s.id === selectedId.value),
);
const selectedDoc = computed(() =>
  selected.value ? session.value?.sections.get(selected.value.docId) : undefined,
);

/** Per-section word counts for the outline (#52): read-only, recounted after edits settle. */
const wordCounts = shallowRef<Record<string, number>>({});
let countTimer: ReturnType<typeof setTimeout> | undefined;
let stopCounts = () => {};
function recount() {
  const s = session.value;
  if (!s) return;
  const out: Record<string, number> = {};
  for (const sec of s.outline.value) {
    const d = s.sections.get(sec.docId);
    if (d) out[sec.id] = docWordCount(d);
  }
  wordCounts.value = out;
}
watch(
  () => [session.value, session.value?.outline.value] as const,
  () => {
    stopCounts();
    const s = session.value;
    if (!s) return;
    const docs = [...new Set(s.outline.value.map((x) => s.sections.get(x.docId)))].filter(
      (d) => !!d,
    );
    const later = () => {
      clearTimeout(countTimer);
      countTimer = setTimeout(recount, 300);
    };
    docs.forEach((d) => d.on('update', later));
    stopCounts = () => docs.forEach((d) => d.off('update', later));
    recount();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  stopCounts();
  clearTimeout(countTimer);
});

/** Focus mode (#56): hides the app chrome; local UI state only. */
const focusMode = ref(false);

/** Title-bar breadcrumb (#52): "Book — Chapter N · Title". */
const breadcrumb = computed(() => {
  const s = session.value;
  const sel = selected.value;
  if (!s || !sel || choosingBook.value) return '';
  const chapters = s.outline.value.filter((x) => x.kind === 'chapter');
  const n = chapters.findIndex((c) => c.id === sel.id);
  const where = n >= 0 ? `Chapter ${n + 1} · ` : '';
  return `${where}${sel.title || 'Untitled'}`;
});

defineExpose({ open });
</script>

<template>
  <main class="shell">
    <header v-show="!focusMode" class="topbar">
      <span class="topbar__name">{{ session && !choosingBook ? session.title : 'coAuthor' }}</span>
      <span v-if="breadcrumb" class="topbar__crumb" data-test="breadcrumb">— {{ breadcrumb }}</span>
      <button
        v-if="session && !choosingBook"
        type="button"
        class="topbar__button topbar__open"
        data-test="open-another"
        @click="choosingBook = true"
      >
        Open another book
      </button>
      <button
        ref="settingsButton"
        type="button"
        class="topbar__button"
        data-test="settings-open"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        Settings
      </button>
    </header>
    <section
      v-if="settingsOpen"
      ref="settingsPanel"
      class="settings"
      role="dialog"
      aria-label="Settings"
      tabindex="-1"
      data-test="settings"
      @keydown.esc="settingsOpen = false"
    >
      <h2>Settings</h2>
      <button type="button" class="btn" data-test="settings-close" @click="settingsOpen = false">
        Close
      </button>
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
        <p v-if="backupStatus" data-test="backup-status">{{ backupStatus }}</p>
        <div v-if="tokensNotice !== null" role="status" data-test="tokens-revoked-notice">
          <p>
            For safety, restoring revoked all {{ tokensNotice }} agent token(s). Your agents are
            kept; create new tokens in Settings → Agents to reconnect them.
          </p>
          <button type="button" data-test="tokens-notice-dismiss" @click="tokensNotice = null">
            Dismiss
          </button>
        </div>
      </section>
      <p v-else data-test="browser-mode">Running in browser mode (no desktop backend).</p>
      <AgentsSettings v-if="info" />
    </section>
    <div v-if="recoveryNotices.length" role="alert" data-test="recovery-notice">
      <p>
        A restore was interrupted. Some attachments may be missing. coAuthor didn't delete anything.
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
    <input
      ref="fileInput"
      class="visually-hidden"
      data-test="open-docx"
      type="file"
      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      tabindex="-1"
      aria-hidden="true"
      :disabled="importing"
      @change="onFile"
    />
    <p v-if="fatalError" role="alert" data-test="fatal-error">{{ fatalError }}</p>
    <p v-if="openError" role="alert" data-test="open-error">{{ openError }}</p>
    <p v-if="saveError" role="alert" data-test="save-error">{{ saveError }}</p>
    <HomeScreen
      v-if="!session || choosingBook"
      ref="home"
      data-test="no-manuscript"
      :step="welcomed ? 'open' : 'welcome'"
      :busy="importing"
      :can-cancel="!!session"
      @cancel="choosingBook = false"
      @get-started="getStarted"
      @choose="chooseFile"
      @drop-file="importFile"
    />
    <div
      v-else
      class="workspace grid gap-4 p-4"
      :class="navigatorOpen && !focusMode ? 'grid-cols-[18rem_1fr]' : 'grid-cols-1'"
      data-test="workspace"
    >
      <SectionNav
        v-show="navigatorOpen && !focusMode"
        id="chapter-navigator"
        class="min-h-0 overflow-auto"
        :sections="session.outline.value"
        :manuscript-id="session.id"
        :selected-id="selectedId"
        :save="session.save"
        :word-counts="wordCounts"
        @select="selectedId = $event"
      />
      <ManuscriptEditor
        v-if="selectedDoc"
        :key="`${selected!.docId}#${reloads}`"
        :doc="selectedDoc"
        :readonly="session.closed"
        :navigator-open="navigatorOpen"
        :chapter-title="selected!.title"
        :book-docs="outlineDocs(session.outline.value, session.sections)"
        :chapter-docs="sectionTreeDocs(session.outline.value, selectedId, session.sections)"
        :save-state="saveError ? 'offline' : undefined"
        @reload="reloads++"
        @toggle-navigator="navigatorOpen = !navigatorOpen"
        @focus-mode="focusMode = $event"
      />
    </div>
  </main>
</template>

<style>
body {
  margin: 0;
}
.shell {
  /* One window-height column: the content ends above the fixed status bar (h-7 = 1.75rem) and
     the chapter list and editor scroll inside it, so the bar never covers either. */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: auto;
  padding-bottom: 1.75rem;
}
.shell > .workspace {
  flex: 1 0 20rem;
  min-height: 0;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: var(--ct-space-2) var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-surface);
}
.topbar__name {
  font-weight: var(--ct-weight-semibold);
  font-size: var(--ct-text-sm);
}
.topbar__crumb {
  margin-left: var(--ct-space-2);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar__open {
  margin-left: auto;
  margin-right: var(--ct-space-2);
}
.btn,
.topbar__button {
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-4);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  color: var(--ct-text);
  font: inherit;
  cursor: pointer;
}
.settings {
  margin: var(--ct-space-4);
  padding: var(--ct-space-6);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
}
.settings h2 {
  margin-top: 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
