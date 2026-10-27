<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  createBackup,
  getAppInfo,
  pickBackupDestination,
  pickBackupToRestore,
  restoreBackup,
  getRecoveryNotices,
  dismissRecoveryNotices,
  getMigrationNotices,
  dismissMigrationNotices,
  type AppInfo,
  type RecoveryNotice,
  type MigrationNotice,
} from './backend';
import SettingsScreen from './settings/SettingsScreen.vue';
import { authorName, refreshAgents, reloadOnFocus } from './agent-names';
import ManuscriptEditor from './ManuscriptEditor.vue';
import SectionNav from './SectionNav.vue';
import {
  toastPlacement,
  useOutlineAutoCollapse,
  type EditorLayout,
} from './desk/outline-auto-collapse';
import HomeScreen from './HomeScreen.vue';
import AppLogo from './AppLogo.vue';
import SaveFailureBanner from './errors/SaveFailureBanner.vue';
import MigrationNoticeBanner from './migration/MigrationNoticeBanner.vue';
import {
  errorLine,
  saveFailed,
  saveSucceeded,
  SAVE_OK,
  SECTION_LOAD_ERROR_COPY,
} from './errors/map-error';
import { saveCopy } from './errors/save-copy';
import { PRODUCT_NAME } from './lib/brand';
import ShellsPreview from './shells/ShellsPreview.vue';
import AppToast from './shells/AppToast.vue';
import { applyThemeParam, readPreview } from './shells/preview';
import { flushOnClose } from './close-flush';
import { resetCollabSlots } from './author-colors';
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
const editorPane = ref<InstanceType<typeof ManuscriptEditor> | null>(null);
/** Outline row clicked (#36): once that section's editor is showing, put the cursor in its body. */
async function focusEditor(id: string) {
  await nextTick();
  if (selectedId.value === id) editorPane.value?.focusBody();
}
/** Notices from startup recovery after an interrupted restore; kept until dismissed. */
const recoveryNotices = ref<RecoveryNotice[]>([]);
const recoveryDismissError = ref('');
/** Rename-migration notices (#43); their own channel, never shown as restore recovery. */
const migrationNotices = ref<MigrationNotice[]>([]);

async function dismissMigration(ids: string[]) {
  migrationNotices.value = migrationNotices.value.filter((n) => !ids.includes(n.id));
  try {
    await dismissMigrationNotices(ids);
  } catch (e) {
    console.error('Dismiss migration notice failed', e);
  }
}

async function dismissRecovery() {
  try {
    const ids = recoveryNotices.value.map((n) => n.id);
    await dismissRecoveryNotices(ids);
    recoveryNotices.value = recoveryNotices.value.filter((n) => !ids.includes(n.id));
    recoveryDismissError.value = '';
  } catch (e) {
    console.error('Dismiss recovery notice failed', e);
    recoveryDismissError.value = `Couldn't dismiss the notice. ${errorLine(e)}`;
  }
}
const openError = ref('');
/** Persistent: nothing can be opened safely until restart. */
const fatalError = ref('');
const REOPEN_BACKOFF_MS = [250, 500, 1000];
const importing = ref(false);
/** Save-failure banner state (#62, ob9): shown while edits are unsaved; cleared once a save
 * succeeds. Edits are never dropped. Raw error text only goes to the console. */
const saveFailure = ref({ ...SAVE_OK });
const saveError = computed(() => saveFailure.value.failing);
const persistHooks = {
  onError: (err: unknown) => {
    console.error('Save failed; retrying', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  },
  onSaved: () => (saveFailure.value = saveSucceeded()),
};
const saveCopyOfOpen = () =>
  session.value ? saveCopy(session.value) : Promise.resolve({ status: 'cancelled' as const });
/**
 * Bumped by the editor's Reload action to reopen the section from its Y.Doc. The editor is bound
 * to that doc, so everything typed is already in it and survives the remount (and switching
 * sections). The remount is a fresh editor, so its undo history is lost; nothing typed while the
 * editor was read-only after a content error was ever accepted, so there is nothing else to lose.
 */
const reloads = ref(0);
/** The open section's load error, shown in a live region that stays mounted (#79). */
const editorLoadError = ref('');
function reloadSection() {
  editorLoadError.value = '';
  reloads.value++;
}
/** The chapter navigator (SectionNav); the toolbar's Chapters button toggles it. */
const navigatorOpen = ref(true);
/** #92: closes the outline while the review panel would squeeze the page below its minimum. */
const outlineAuto = useOutlineAutoCollapse(navigatorOpen);
/** Last desk layout from the editor; the open-book toast stays on the desk (#93). */
const editorLayout = shallowRef<EditorLayout | null>(null);
const toastStyle = computed(() => (session.value ? toastPlacement(editorLayout.value) : null));
function onEditorLayout(l: EditorLayout) {
  editorLayout.value = l;
  outlineAuto.update(l);
}

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
// UI-shell previews (Part of #36): `?preview=<id|all>`, or Settings → Preview new screens.
applyThemeParam(window.location.search, document.documentElement);
const preview = ref(readPreview(window.location.search));
function openPreview(id: 'all') {
  settingsOpen.value = false;
  preview.value = id;
}
const settingsButton = ref<HTMLButtonElement | null>(null);
watch(settingsOpen, async (isOpen) => {
  await nextTick();
  // SettingsScreen moves focus into itself on mount; back to the button that opened it on close.
  if (!isOpen) settingsButton.value?.focus();
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
      migrationNotices.value = await getMigrationNotices();
    } catch {
      migrationNotices.value = [];
    }
    try {
      recoveryNotices.value = await getRecoveryNotices();
      // Raw reasons stay in the log; the notice shows only plain copy.
      for (const n of recoveryNotices.value)
        console.warn('Recovery notice', n.reason, n.saveError ?? '');
    } catch {
      recoveryNotices.value = [];
    }
    try {
      const latest = await reopenLatest(persistHooks);
      if (latest && !session.value) open(latest);
    } catch (err) {
      console.error('Reopen failed', err);
      openError.value = `Couldn't reopen the last manuscript. ${errorLine(err, 'open')}`;
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
    console.error('File picker failed', e);
    backupStatus.value = `Couldn't open the file picker. ${errorLine(e)}`;
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
    console.error('Backup failed', e);
    backupStatus.value = `Backup failed. ${errorLine(e)}`;
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
      console.error('Restore flush failed', e);
      backupStatus.value = `Restore cancelled: ${errorLine(e, 'save')} Nothing was changed.`;
      return;
    }
    const r = await restoreBackup(restorePath.value.trim());
    // The restore replaced storage, so the open session's in-memory docs are stale: close them
    // (stops the structure observer and unmounts the editor) so nothing can write them back.
    closeSession();
    backupStatus.value = `Restored. Previous state saved: ${r.preRestoreSnapshot}`;
    tokensNotice.value = r.tokensRevoked > 0 ? r.tokensRevoked : null;
  } catch (e) {
    console.error('Restore failed', e);
    backupStatus.value = `Restore failed. ${errorLine(e, 'open')}`;
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
  if (session.value !== next) {
    closeQuietly(session.value);
    // Author color slots are per manuscript: numbering restarts for each book opened (#72).
    resetCollabSlots();
  }
  // A toast from an earlier book must never describe this one; callers re-show it on success.
  dismissToast();
  saveFailure.value = saveSucceeded();
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
  fatalError.value = `Couldn't reopen the manuscript. Please restart ${PRODUCT_NAME}.`;
  return null;
}

/** ob7: "Your book is open" toast after a successful open/import; hides itself after a while. */
const TOAST_MS = 8000;
const openToast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastToken = 0;
function dismissToast() {
  toastToken++;
  clearTimeout(toastTimer);
  openToast.value = '';
}
function showOpenToast(next: ManuscriptSession) {
  const n = next.outline.value.filter((s) => s.kind === 'chapter').length;
  const here =
    n > 1
      ? `All ${n} chapters are here, and your`
      : n === 1
        ? 'Your chapter is here, and your'
        : 'Your';
  const text = `${here} original file is untouched.`;
  // Clear first and set the text on the next tick: re-importing while the toast is up must
  // change the region's DOM, or screen readers won't announce it again (#82).
  clearTimeout(toastTimer);
  openToast.value = '';
  const token = ++toastToken;
  void nextTick(() => {
    if (token !== toastToken) return;
    openToast.value = text;
    toastTimer = setTimeout(dismissToast, TOAST_MS);
  });
}
onBeforeUnmount(() => clearTimeout(toastTimer));

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
      const next = await importAndOpen(bytes, persistHooks, current);
      open(next);
      showOpenToast(next);
    } catch (err) {
      // The current manuscript was closed but the import failed: never leave the closed session
      // on screen; reopen the newest stored manuscript (the import, if it was written).
      // A refused close keeps the current manuscript on screen: keep following agent writes.
      if (current && !current.closed && session.value === current) current.resumeLive?.();
      if (current?.closed) {
        const back = await reopenAfterFailure();
        // The newest manuscript is not the one we closed, so the import was saved and is now
        // open: the import worked and there is nothing to report.
        if (back && back.id !== current.id) {
          showOpenToast(back);
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    console.error('Import failed', err);
    dismissToast();
    openError.value =
      err instanceof UnsavedEditsError
        ? `Couldn't open ${file.name}: some edits in the current manuscript aren't saved yet`
        : `Couldn't open ${file.name}. ${errorLine(err, 'import')}`;
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
/** #96: the writer opened the outline by hand while the review panel shows. */
const outlineForced = computed(() => outlineAuto.manual.value && navigatorOpen.value);

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

const NUMBER_WORDS = [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];
/** Display-only chapter label above the H1 ("Chapter Three"); never written into the doc. */
const chapterLabel = computed(() => {
  const s = session.value;
  const sel = selected.value;
  if (!s || !sel || sel.kind !== 'chapter') return '';
  const n =
    s.outline.value.filter((x) => x.kind === 'chapter').findIndex((c) => c.id === sel.id) + 1;
  return n ? `Chapter ${NUMBER_WORDS[n - 1] ?? n}` : '';
});

defineExpose({ open });
</script>

<template>
  <ShellsPreview v-if="preview" class="shell" :initial="preview" @close="preview = null" />
  <main v-else class="shell">
    <header v-show="!focusMode" class="topbar">
      <span class="topbar__brand">
        <AppLogo :size="24" />
        <span class="topbar__name">{{
          session && !choosingBook ? session.title : PRODUCT_NAME
        }}</span>
      </span>
      <span v-if="breadcrumb" class="topbar__crumb" data-test="breadcrumb">— {{ breadcrumb }}</span>
      <details class="topbar__menu" data-test="app-menu">
        <summary class="topbar__icon" aria-label="Book menu" title="Book menu">⋯</summary>
        <div
          class="topbar__menu-list"
          @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"
        >
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
        </div>
      </details>
    </header>
    <MigrationNoticeBanner :notices="migrationNotices" @dismiss="dismissMigration" />
    <SettingsScreen
      v-if="settingsOpen"
      v-model:restore-path="restorePath"
      :info="info"
      :backup-status="backupStatus"
      :confirming-restore="confirmingRestore"
      :tokens-notice="tokensNotice"
      @close="settingsOpen = false"
      @open-previews="openPreview('all')"
      @backup="onBackup"
      @pick-restore="chooseRestoreFile"
      @ask-restore="askRestore"
      @confirm-restore="onRestore"
      @cancel-restore="confirmingRestore = false"
      @dismiss-notice="tokensNotice = null"
    />
    <div v-if="recoveryNotices.length" role="alert" data-test="recovery-notice">
      <p>
        A restore was interrupted. Some attachments may be missing. {{ PRODUCT_NAME }} didn't delete
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
          {{ PRODUCT_NAME }} couldn't finish and will try again the next time it starts.
        </p>
        <p v-if="n.corruptFile" data-test="recovery-notice-corrupt">
          An earlier notice couldn't be read. It was kept, not deleted, at
          <code>{{ n.corruptFile }}</code
          >.
        </p>
        <p v-if="n.saveError" data-test="recovery-notice-save-error">
          This notice couldn't be saved and won't show again after you close {{ PRODUCT_NAME }}.
          {{ errorLine(n.saveError, 'save') }}
        </p>
      </div>
      <button type="button" data-test="recovery-notice-dismiss" @click="dismissRecovery">
        Dismiss
      </button>
      <p v-if="recoveryDismissError">{{ recoveryDismissError }}</p>
    </div>
    <!-- Always mounted so screen readers know the region before an error lands in it (#79). -->
    <div
      class="editor-error-region"
      role="alert"
      aria-live="assertive"
      data-test="load-error-region"
    >
      <p
        v-if="editorLoadError && session && !choosingBook"
        class="load-error"
        data-test="load-error"
      >
        {{ SECTION_LOAD_ERROR_COPY }}
        <button type="button" class="sh-btn" data-test="reload" @click="reloadSection">
          Reload section
        </button>
      </p>
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
    <SaveFailureBanner
      v-if="saveFailure.failing"
      data-test="save-error"
      :state="saveFailure"
      :save-copy="saveCopyOfOpen"
    />
    <!-- Always mounted so the live region exists before its text (#79). -->
    <div class="open-toast" data-test="open-toast" :style="toastStyle ?? undefined">
      <AppToast
        :open="!!openToast && !!session"
        lead="Your book is open."
        :message="openToast"
        @dismiss="dismissToast"
      />
    </div>
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
    <!-- #84: full-width toolbar row under the title bar; the side panels start below it. -->
    <div
      v-if="session && !choosingBook"
      id="toolbar-row"
      class="toolbar-row"
      data-test="toolbar-row"
    />
    <div
      v-if="session && !choosingBook"
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
        @activate="focusEditor"
      />
      <ManuscriptEditor
        v-if="selectedDoc"
        ref="editorPane"
        :key="`${selected!.docId}#${reloads}`"
        :doc="selectedDoc"
        :readonly="session.closed"
        :navigator-open="navigatorOpen"
        :chapter-title="selected!.title"
        :chapter-label="chapterLabel"
        :book-docs="outlineDocs(session.outline.value, session.sections)"
        :chapter-docs="sectionTreeDocs(session.outline.value, selectedId, session.sections)"
        :save-state="saveError ? 'offline' : undefined"
        :author-labels="authorName"
        toolbar-target="#toolbar-row"
        external-load-error
        :outline-forced="outlineForced"
        @load-error="editorLoadError = $event"
        @reload="reloadSection"
        @toggle-navigator="outlineAuto.toggleByHand()"
        @layout="onEditorLayout"
        @focus-mode="focusMode = $event"
      />
    </div>
  </main>
</template>

<style>
.open-toast {
  position: fixed;
  bottom: var(--ct-space-12);
  left: 50%;
  z-index: 40;
  transform: translateX(-50%);
}
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
.toolbar-row {
  flex: none;
  background: var(--ct-surface);
}
.toolbar-row:empty {
  display: none;
}
.editor-error-region .load-error {
  margin: var(--ct-space-2) var(--ct-space-4) 0;
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
.topbar__brand {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
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
.topbar__menu {
  position: relative;
  margin-left: auto;
}
.topbar__icon {
  list-style: none;
  padding: 0 var(--ct-space-2);
  color: var(--ct-text-muted);
  cursor: pointer;
}
.topbar__icon::-webkit-details-marker {
  display: none;
}
.topbar__menu-list {
  position: absolute;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  padding: var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  white-space: nowrap;
}
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
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
