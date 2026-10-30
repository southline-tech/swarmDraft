<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  createBackup,
  getAppInfo,
  restoreBackup,
  getRecoveryNotices,
  dismissRecoveryNotices,
  getMigrationNotices,
  dismissMigrationNotices,
  listManuscripts,
  loadManuscript,
  listenOpeningProgress,
  manuscriptReviewDecisions,
  saveSectionReviewDecisions,
  type AppInfo,
  type OpeningProgressEvent,
  type RecoveryNotice,
  type MigrationNotice,
  type StoredManuscriptRow,
} from './backend';
import SettingsScreen from './settings/SettingsScreen.vue';
import { markAuthorLabel, refreshAgents, reloadOnFocus } from './agent-names';
import ContinuousManuscript from './ContinuousManuscript.vue';
import SectionNav from './SectionNav.vue';
import OutlineRail from './desk/OutlineRail.vue';
import {
  toastPlacement,
  useOutlineAutoCollapse,
  type EditorLayout,
} from './desk/outline-auto-collapse';
import HomeScreen from './HomeScreen.vue';
import AppLogo from './AppLogo.vue';
import AppIcon from './icons/AppIcon.vue';
import SaveFailureBanner from './errors/SaveFailureBanner.vue';
import MigrationNoticeBanner from './migration/MigrationNoticeBanner.vue';
import {
  errorLine,
  mapError,
  saveFailed,
  saveSucceeded,
  SAVE_OK,
  SECTION_LOAD_ERROR_COPY,
  type MappedError,
} from './errors/map-error';
import { saveCopy } from './errors/save-copy';
import { BUSY_NOTICE } from './errors/busy';
import { PRODUCT_NAME } from './lib/brand';
import ShellsPreview from './shells/ShellsPreview.vue';
import Rad60ReviewEvidence from './evidence/Rad60ReviewEvidence.vue';
import Rad67EditorChromeEvidence from './evidence/Rad67EditorChromeEvidence.vue';
import AppToast from './shells/AppToast.vue';
import OpeningProgress from './shells/OpeningProgress.vue';
import ErrorCard from './shells/ErrorCard.vue';
import {
  OPENING_REVEAL_MS,
  errorCardIcon,
  openingStateFromEvent,
  titleFromDocxName,
  type OpeningRetry,
  type OpeningUiState,
} from './errors/opening-flow';
import './shells/shells.css';
import { applyThemeParam, readPreview } from './shells/preview';
import { CLOSE_FLUSH_TIMEOUT_MS, confirmQuit, flushOnClose, flushWithTimeout } from './close-flush';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { resetCollabSlots } from './author-colors';
import { sectionNumberLabels } from '@coauthor/editor';
import type { NumberingStyle } from '@coauthor/schema';
import type { DecisionRecord } from '@coauthor/editor';
import { mergeLoadedDecisionRecords } from './review/decision-records-load';
import { docWordCount, outlineDocs, sectionTreeDocs } from './status/wordcount';
import {
  importAndOpen,
  openStored,
  reopenLatest,
  UnsavedEditsError,
  type ManuscriptSession,
} from './manuscript-session';

const info = ref<AppInfo | null>(null);
const session = shallowRef<ManuscriptSession | null>(null);
const selectedId = ref<string>();
const editorPane = ref<InstanceType<typeof ContinuousManuscript> | null>(null);
/** Outline row clicked (#36): scroll to the section and put the caret in its body (#107). */
async function focusEditor(id: string) {
  selectedId.value = id;
  await nextTick();
  editorPane.value?.focusSection(id);
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
/** ob6: backend-driven opening progress; revealed only after a short delay (#80). */
const opening = ref<OpeningUiState | null>(null);
const openingVisible = ref(false);
const openingError = ref<MappedError | null>(null);
const openingRetry = ref<OpeningRetry | null>(null);
let openingRevealTimer: ReturnType<typeof setTimeout> | undefined;
let stopOpeningProgress = () => {};
function onOpeningProgress(event: OpeningProgressEvent) {
  if (!opening.value) return;
  opening.value = openingStateFromEvent(opening.value, event);
}
function startOpening(title: string) {
  clearTimeout(openingRevealTimer);
  openingVisible.value = false;
  openingError.value = null;
  opening.value = { title, found: 0, progress: 0 };
  openingRevealTimer = setTimeout(() => {
    if (opening.value) openingVisible.value = true;
  }, OPENING_REVEAL_MS);
}
function finishOpening() {
  clearTimeout(openingRevealTimer);
  openingVisible.value = false;
  opening.value = null;
  openingError.value = null;
  openingRetry.value = null;
}
function failOpening(err: unknown, context: 'open' | 'import') {
  clearTimeout(openingRevealTimer);
  openingVisible.value = false;
  opening.value = null;
  openingError.value = mapError(err, context);
}
function onOpeningErrorAction() {
  const err = openingError.value;
  if (!err) return;
  if (err.action === 'choose-another-file') {
    openingError.value = null;
    openingRetry.value = null;
    chooseFile();
    return;
  }
  if (err.action === 'try-again') {
    openingError.value = null;
    void runOpeningRetry();
    return;
  }
  openingError.value = null;
}

async function runOpeningRetry() {
  const retry = openingRetry.value;
  if (!retry) {
    chooseFile();
    return;
  }
  if (retry.kind === 'reopen-latest') {
    startOpening(retry.title);
    try {
      const latest = await reopenLatest(persistHooks);
      if (latest && !session.value) {
        finishOpening();
        open(latest);
      } else finishOpening();
    } catch (e) {
      console.error('Reopen retry failed', e);
      failOpening(e, 'open');
    }
    return;
  }
  if (retry.kind === 'open-manuscript') {
    await openRecentBook(retry.id);
    return;
  }
  if (retry.kind === 'import') await importBytes(retry.name, retry.bytes);
}
/** Save-failure banner state (#62, ob9): shown while edits are unsaved; cleared once a save
 * succeeds. Edits are never dropped. Raw error text only goes to the console. */
const saveFailure = ref({ ...SAVE_OK });
const saveError = computed(() => saveFailure.value.failing);
/** RAD-265: show "Saved" in the status bar after at least one successful persist. */
const saveStatusShown = ref(false);
const persistHooks = {
  onError: (err: unknown) => {
    console.error('Save failed; retrying', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  },
  onSaved: () => {
    saveFailure.value = saveSucceeded();
    saveStatusShown.value = true;
  },
};
const saveStatus = computed(() =>
  saveError.value ? 'offline' : saveStatusShown.value ? 'saved' : undefined,
);
const saveCopyOfOpen = () =>
  session.value ? saveCopy(session.value) : Promise.resolve({ status: 'cancelled' as const });
/**
 * Bumped by the editor's Reload action to reopen the section from its Y.Doc. The editor is bound
 * to that doc, so everything typed is already in it and survives the remount (and switching
 * sections). The remount is a fresh editor, so its undo history is lost; nothing typed while the
 * editor was read-only after a content error was ever accepted, so there is nothing else to lose.
 */
const reloads = ref(0);
/** Persisted accept/reject records per section (#51). */
const decisionRecordsBySection = shallowRef<Record<string, DecisionRecord[]>>({});
let decisionLoadGeneration = 0;
function snapshotDecisionRecords(
  source: Readonly<Record<string, DecisionRecord[]>>,
): Record<string, DecisionRecord[]> {
  const out: Record<string, DecisionRecord[]> = {};
  for (const [sectionId, rows] of Object.entries(source)) {
    out[sectionId] = [...rows];
  }
  return out;
}
async function loadDecisionRecords(manuscriptId: string) {
  const generation = ++decisionLoadGeneration;
  const atLoadStart = snapshotDecisionRecords(decisionRecordsBySection.value);
  try {
    const incoming = await manuscriptReviewDecisions(manuscriptId);
    if (session.value?.id !== manuscriptId || generation !== decisionLoadGeneration) return;
    const current = decisionRecordsBySection.value;
    decisionRecordsBySection.value = mergeLoadedDecisionRecords(atLoadStart, incoming, current);
  } catch (err) {
    if (session.value?.id !== manuscriptId || generation !== decisionLoadGeneration) return;
    console.error('Could not load review decisions', err);
    decisionRecordsBySection.value = {};
  }
}
function onSectionDecisions(sectionId: string, records: DecisionRecord[]) {
  if (!session.value) return;
  decisionRecordsBySection.value = { ...decisionRecordsBySection.value, [sectionId]: records };
  void saveSectionReviewDecisions(session.value.id, sectionId, records).catch((err) => {
    console.error('Review decision save failed; next change will retry', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  });
}
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
/** Toasts hide themselves after this long (ob7, #98). */
const TOAST_MS = 8000;
/** #98: the writer hid the margin notes to make room for the outline (until the panel closes). */
const notesHidden = ref(false);
/** #98: "Not enough room" cue after Chapters is clicked with page + notes filling the desk. */
const NO_ROOM_COPY = 'Not enough room for the outline while notes are showing.';
const noRoomToast = ref(false);
let noRoomTimer: ReturnType<typeof setTimeout> | undefined;
function dismissNoRoom() {
  clearTimeout(noRoomTimer);
  noRoomToast.value = false;
}
watch(
  () => outlineAuto.noRoom.value,
  () => {
    if (noRoomToast.value) return; // already showing: don't announce it again
    dismissToast();
    noRoomToast.value = true;
    noRoomTimer = setTimeout(dismissNoRoom, TOAST_MS);
  },
);
onBeforeUnmount(() => clearTimeout(noRoomTimer));
function hideNotesForOutline() {
  dismissNoRoom();
  notesHidden.value = true;
  outlineAuto.openByHand();
}
/** Last desk layout from the editor; the open-book toast stays on the desk (#93). */
const editorLayout = shallowRef<EditorLayout | null>(null);
const toastStyle = computed(() => (session.value ? toastPlacement(editorLayout.value) : null));
function onEditorLayout(l: EditorLayout) {
  const prev = editorLayout.value;
  // #98: the no-room cue is about the layout it was shown in; any change closes it.
  if (
    noRoomToast.value &&
    (!prev ||
      prev.reviewShown !== l.reviewShown ||
      prev.marginNotes !== l.marginNotes ||
      prev.deskWidth !== l.deskWidth ||
      !!prev.focusMode !== !!l.focusMode)
  )
    dismissNoRoom();
  if (!l.reviewShown && !l.focusMode) notesHidden.value = false;
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
const evidence = ref(new URLSearchParams(window.location.search).get('evidence'));
const preview = ref(readPreview(window.location.search));
function openPreview(id: 'all') {
  settingsOpen.value = false;
  preview.value = id;
}
const settingsButton = ref<HTMLButtonElement | null>(null);
const recentOpen = ref(false);
const recentBooks = ref<StoredManuscriptRow[]>([]);
async function refreshRecentBooks() {
  try {
    recentBooks.value = await listManuscripts();
  } catch (e) {
    console.error('List manuscripts failed', e);
    recentBooks.value = [];
  }
}
const appMenu = ref<HTMLDetailsElement | null>(null);
function closeBookMenu() {
  appMenu.value?.removeAttribute('open');
  recentOpen.value = false;
}
function onAppMenuToggle(e: Event) {
  const open = (e.target as HTMLDetailsElement).open;
  if (open) void refreshRecentBooks();
  else recentOpen.value = false;
}
function openBookPicker() {
  if (session.value) choosingBook.value = true;
  else void getStarted();
}
let openingRecent = false;
async function openRecentBook(id: string) {
  if (openingRecent || session.value?.id === id) return;
  openingRecent = true;
  const title = recentBooks.value.find((m) => m.id === id)?.title || 'your book';
  openingRetry.value = { kind: 'open-manuscript', id, title };
  startOpening(title);
  try {
    try {
      await session.value?.flush();
    } catch (e) {
      console.error('Flush before open failed', e);
      finishOpening();
      openError.value = `Couldn't switch books: ${errorLine(e, 'save')}`;
      return;
    }
    openError.value = '';
    const stored = await loadManuscript(id);
    if (!stored) {
      failOpening('not found: manuscript', 'open');
      return;
    }
    const next = openStored(stored, null, persistHooks);
    finishOpening();
    open(next);
    showOpenToast(next);
    closeBookMenu();
  } catch (e) {
    console.error('Open recent failed', e);
    failOpening(e, 'open');
  } finally {
    openingRecent = false;
  }
}
async function quitApp() {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  if (
    (await flushWithTimeout(
      () => session.value?.flush() ?? Promise.resolve(),
      CLOSE_FLUSH_TIMEOUT_MS,
    )) !== 'saved' &&
    !(await confirmQuit())
  )
    return;
  await win.destroy();
}
watch(settingsOpen, async (isOpen) => {
  await nextTick();
  // SettingsScreen moves focus into itself on mount; back to the button that opened it on close.
  if (!isOpen) settingsButton.value?.focus();
});
const fileInput = ref<HTMLInputElement | null>(null);
const chooseFile = () => fileInput.value?.click();

/** Book-menu shortcuts wired in this build (#104 Designer). */
const appMenuShortcuts = computed(() => ({
  new: importing.value ? undefined : 'Ctrl+N',
  open: 'Ctrl+O',
  settings: 'Ctrl+,',
  quit: isTauri() ? 'Ctrl+Q' : undefined,
}));

const menuField = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=true]');

function onAppMenuKey(e: KeyboardEvent) {
  if (preview.value) return;
  if (menuField(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.shiftKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n' && !importing.value) {
    e.preventDefault();
    chooseFile();
  } else if (k === 'o') {
    e.preventDefault();
    openBookPicker();
  } else if (e.key === ',') {
    e.preventDefault();
    settingsOpen.value = !settingsOpen.value;
  } else if (k === 'q' && isTauri()) {
    e.preventDefault();
    void quitApp();
  }
}

let stopCloseFlush = () => {};
let stopAppMenuKeys = () => {};
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
  window.addEventListener('keydown', onAppMenuKey);
  void refreshAgents();
  stopAppMenuKeys = () => window.removeEventListener('keydown', onAppMenuKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('dragover', blockFileNavigation);
  window.removeEventListener('drop', blockFileNavigation);
  window.removeEventListener('focus', reloadAgents);
  stopAppMenuKeys();
});
onMounted(async () => {
  stopOpeningProgress = await listenOpeningProgress(onOpeningProgress);
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
      let reopenTitle = 'your book';
      try {
        const books = await listManuscripts();
        const t = books[0]?.title?.trim();
        if (t) reopenTitle = t;
      } catch (e) {
        console.error('List manuscripts before reopen failed', e);
      }
      openingRetry.value = { kind: 'reopen-latest', title: reopenTitle };
      startOpening(reopenTitle);
      const latest = await reopenLatest(persistHooks);
      if (latest && !session.value) {
        finishOpening();
        open(latest);
      } else finishOpening();
    } catch (err) {
      console.error('Reopen failed', err);
      finishOpening();
      openError.value = `Couldn't reopen the last manuscript. ${errorLine(err, 'open')}`;
    }
  }
  stopCloseFlush = await flushOnClose(() => session.value?.flush() ?? Promise.resolve());
});

const backupStatus = ref('');
/** Plain notices for the restore codes from the backend (#83, #86); anything else is generic. */
const RESTORE_NOTICES: Record<string, string> = {
  'not-a-backup': "That file isn't a backup. Nothing was changed.",
  'too-new': 'This backup is from a newer version of swarmDraft. Update the app, then try again.',
  busy: BUSY_NOTICE,
  // Only sent when nothing was replaced or the swap was rolled back (RollbackFailed is
  // 'restore-incomplete'), so "wasn't changed" is true.
  'restore-failed': "The restore didn't finish, and your book wasn't changed. Please try again.",
  'restore-incomplete':
    "The restore didn't finish, so swarmDraft closed your book to keep it safe. A copy from just before the restore is in the backups folder.",
};
const confirmingRestore = ref(false);
/** RAD-237: lock editing while the backend restore runs. */
const restoreInProgress = ref(false);
/** One-time notice after a restore revoked agent tokens; cleared when dismissed. */
const tokensNotice = ref<number | null>(null);

async function onBackup(): Promise<void> {
  try {
    if (await createBackup()) backupStatus.value = 'Backup saved.';
  } catch (e) {
    console.error('backup failed', e);
    backupStatus.value = e === 'busy' ? BUSY_NOTICE : "The backup wasn't saved. Please try again.";
  }
}

async function onRestore(): Promise<void> {
  confirmingRestore.value = false;
  // Save pending edits first so the pre-restore snapshot includes them; if they can't be
  // saved, don't restore (that would lose them).
  try {
    await session.value?.flush();
  } catch (e) {
    console.error('Restore flush failed', e);
    backupStatus.value = `Restore cancelled: ${errorLine(e, 'save')} Nothing was changed.`;
    return;
  }
  restoreInProgress.value = true;
  try {
    // The backend opens the file picker and validates the backup (#83).
    const r = await restoreBackup();
    if (!r) return;
    // The restore replaced storage, so the open session's in-memory docs are stale: close them
    // (stops the structure observer and unmounts the editor) so nothing can write them back.
    closeSession();
    backupStatus.value =
      'Restored. A copy of your book from just before the restore is in the backups folder.';
    tokensNotice.value = r.tokensRevoked > 0 ? r.tokensRevoked : null;
  } catch (e) {
    console.error('Restore failed', e);
    // Storage may be mid-swap: close the session so stale in-memory docs can't be saved.
    if (e === 'restore-incomplete') closeSession();
    backupStatus.value =
      (typeof e === 'string' && RESTORE_NOTICES[e]) ||
      "The restore didn't finish. Please try again.";
  } finally {
    restoreInProgress.value = false;
  }
}
onBeforeUnmount(() => {
  stopCloseFlush();
  stopOpeningProgress();
  clearTimeout(openingRevealTimer);
  closeQuietly(session.value);
});

function syncWindowTitle(title: string) {
  document.title = title;
  if (isTauri())
    void getCurrentWindow()
      .setTitle(title)
      .catch((e) => console.error(e));
}

/** Close the open manuscript, if any, and clear the selection. */
function closeSession() {
  // Storage was replaced: drop pending edits rather than write them into the restored data.
  void session.value?.close({ discard: true });
  session.value = null;
  saveStatusShown.value = false;
  decisionRecordsBySection.value = {};
  selectedId.value = undefined;
  choosingBook.value = false;
  syncWindowTitle(PRODUCT_NAME);
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
  saveStatusShown.value = false;
  // A manuscript is open again, so an earlier "please restart" or open failure no longer holds.
  fatalError.value = '';
  openError.value = '';
  openingError.value = null;
  // Anyone with a book open is past first run: never flash the welcome at them.
  markWelcomed();
  choosingBook.value = false;
  session.value = next;
  decisionRecordsBySection.value = {};
  void loadDecisionRecords(next.id);
  syncWindowTitle(next.title || PRODUCT_NAME);
  const rows = next.outline.value;
  selectedId.value = rows.find((s) => s.kind === 'chapter')?.id;
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
const openToast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastToken = 0;
function dismissToast() {
  toastToken++;
  clearTimeout(toastTimer);
  openToast.value = '';
}
function showOpenToast(next: ManuscriptSession) {
  dismissNoRoom();
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

async function importBytes(fileName: string, bytes: Uint8Array) {
  if (importing.value) return;
  openError.value = '';
  openingRetry.value = { kind: 'import', name: fileName, bytes: bytes.slice() };
  startOpening(titleFromDocxName(fileName));
  importing.value = true;
  try {
    const current = session.value;
    try {
      const next = await importAndOpen(bytes, persistHooks, current);
      finishOpening();
      open(next);
      showOpenToast(next);
    } catch (err) {
      if (current && !current.closed && session.value === current) current.resumeLive?.();
      if (current?.closed) {
        const back = await reopenAfterFailure();
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
    if (err instanceof UnsavedEditsError) {
      finishOpening();
      openingRetry.value = null;
      openError.value = `Couldn't open ${fileName}: some edits in the current manuscript aren't saved yet`;
    } else {
      failOpening(err, 'import');
      if (session.value && !choosingBook.value) {
        openError.value = `Couldn't open ${fileName}. ${errorLine(err, 'import')}`;
      }
    }
  } finally {
    importing.value = false;
  }
}

async function importFile(file: File) {
  if (importing.value) return;
  if (!isWordFile(file)) {
    openError.value = NOT_WORD_FILE;
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.error('Import failed', err);
    dismissToast();
    failOpening(err, 'import');
    if (session.value && !choosingBook.value) {
      openError.value = `Couldn't open ${file.name}. ${errorLine(err, 'import')}`;
    }
    return;
  }
  await importBytes(file.name, bytes);
}

const selected = computed(() =>
  session.value?.outline.value.find((s) => s.id === selectedId.value),
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
/** Set when the writer chooses Ask bot from the editor menu (#54 wiring to App). */
const askBotRequested = ref(false);
function onAskBotFromEditor() {
  askBotRequested.value = true;
}
/** #96: the writer opened the outline by hand while the review panel shows. */
const outlineForced = computed(() => outlineAuto.manual.value && navigatorOpen.value);
/** wp2 (#67): full outline, collapsed rail, or hidden in focus mode. */
const workspaceGridClass = computed(() => {
  if (focusMode.value) return 'grid-cols-1';
  return navigatorOpen.value ? 'grid-cols-[18rem_1fr]' : 'grid-cols-[var(--ct-rail-w)_1fr]';
});
const chapterNavControls = computed(() =>
  navigatorOpen.value ? 'chapter-navigator' : 'chapter-navigator-rail',
);

const sectionLabels = computed(() => {
  const s = session.value;
  if (!s) return new Map<string, string>();
  return sectionNumberLabels(s.outline.value, s.numberingStyle.value);
});

async function onNumberingStyle(style: NumberingStyle) {
  await session.value?.setNumberingStyle(style);
}

defineExpose({ open, closeSession });
</script>

<template>
  <Rad60ReviewEvidence v-if="evidence === 'rad60-review'" class="shell" />
  <Rad67EditorChromeEvidence v-else-if="evidence === 'rad67'" class="shell" />
  <ShellsPreview v-else-if="preview" class="shell" :initial="preview" @close="preview = null" />
  <main v-else class="shell">
    <header v-show="!focusMode" class="topbar">
      <details ref="appMenu" class="topbar__menu" data-test="app-menu" @toggle="onAppMenuToggle">
        <summary
          class="topbar__trigger"
          data-test="app-menu-trigger"
          aria-label="Book menu"
          title="Book menu"
          aria-haspopup="menu"
        >
          <AppIcon name="menu" class="topbar__hamburger" />
          <AppLogo :size="24" />
        </summary>
        <div class="topbar__menu-list sh-menu" role="menu">
          <button
            type="button"
            class="sh-mi"
            role="menuitem"
            data-test="app-menu-new"
            :aria-disabled="importing ? 'true' : undefined"
            @click="
              () => {
                if (importing) return;
                chooseFile();
                closeBookMenu();
              }
            "
          >
            <span class="sh-mi-lead" aria-hidden="true"
              ><AppIcon name="plus" class="app-menu-icon"
            /></span>
            New<span v-if="appMenuShortcuts.new" class="sh-k">{{ appMenuShortcuts.new }}</span>
          </button>
          <button
            type="button"
            class="sh-mi topbar__open"
            role="menuitem"
            data-test="app-menu-open"
            @click="
              () => {
                openBookPicker();
                closeBookMenu();
              }
            "
          >
            <span class="sh-mi-lead" aria-hidden="true"
              ><AppIcon name="folder" class="app-menu-icon"
            /></span>
            Open<span class="sh-k">{{ appMenuShortcuts.open }}</span>
          </button>
          <div
            class="topbar__recent"
            @mouseenter="recentOpen = true"
            @mouseleave="recentOpen = false"
          >
            <button
              type="button"
              class="sh-mi"
              role="menuitem"
              aria-haspopup="menu"
              :aria-expanded="recentOpen"
              data-test="app-menu-recent"
              :aria-disabled="!recentBooks.length ? 'true' : undefined"
              @click.stop="recentBooks.length && (recentOpen = !recentOpen)"
            >
              <span class="sh-mi-lead" aria-hidden="true"
                ><AppIcon name="clock" class="app-menu-icon"
              /></span>
              Recent<span class="sh-k">›</span>
            </button>
            <div
              v-if="recentOpen && recentBooks.length"
              class="topbar__menu-list sh-menu sh-sub topbar__submenu"
              role="menu"
              aria-label="Recent books"
              @click.stop
            >
              <button
                v-for="m in recentBooks"
                :key="m.id"
                type="button"
                class="sh-mi"
                role="menuitem"
                :data-test="`app-menu-recent-${m.id}`"
                @click="openRecentBook(m.id)"
              >
                {{ m.title || 'Untitled' }}
              </button>
            </div>
          </div>
          <div class="sh-sep" role="separator" />
          <button
            ref="settingsButton"
            type="button"
            class="sh-mi"
            role="menuitem"
            data-test="settings-open"
            :aria-expanded="settingsOpen"
            @click="
              () => {
                settingsOpen = !settingsOpen;
                closeBookMenu();
              }
            "
          >
            <span class="sh-mi-lead" aria-hidden="true"
              ><AppIcon name="settings" class="app-menu-icon"
            /></span>
            Settings<span class="sh-k">{{ appMenuShortcuts.settings }}</span>
          </button>
          <button
            v-if="isTauri()"
            type="button"
            class="sh-mi"
            role="menuitem"
            data-test="app-menu-quit"
            @click="
              () => {
                void quitApp();
                closeBookMenu();
              }
            "
          >
            <span class="sh-mi-lead" aria-hidden="true"
              ><AppIcon name="power" class="app-menu-icon"
            /></span>
            Quit<span class="sh-k">{{ appMenuShortcuts.quit }}</span>
          </button>
        </div>
      </details>
      <span class="topbar__brand">
        <span class="topbar__name">{{
          session && !choosingBook ? session.title : PRODUCT_NAME
        }}</span>
      </span>
    </header>
    <MigrationNoticeBanner :notices="migrationNotices" @dismiss="dismissMigration" />
    <SettingsScreen
      v-if="settingsOpen"
      :info="info"
      :backup-status="backupStatus"
      :confirming-restore="confirmingRestore"
      :tokens-notice="tokensNotice"
      :book-open="!!session && !choosingBook"
      :numbering-style="session?.numberingStyle.value"
      @close="settingsOpen = false"
      @numbering-style="onNumberingStyle"
      @open-previews="openPreview('all')"
      @backup="onBackup"
      @ask-restore="confirmingRestore = true"
      @confirm-restore="onRestore"
      @cancel-restore="confirmingRestore = false"
      @dismiss-notice="tokensNotice = null"
    />
    <p v-if="askBotRequested" class="visually-hidden" data-test="ask-bot-requested" role="status">
      Ask bot requested
    </p>
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
      <!-- #98: the no-room cue shares this one polite region with the open-book toast. -->
      <AppToast
        :open="(!!openToast || noRoomToast) && !!session"
        :lead="noRoomToast ? undefined : 'Your book is open.'"
        :message="noRoomToast ? NO_ROOM_COPY : openToast"
        :action="noRoomToast ? 'Hide notes' : undefined"
        :icon="noRoomToast ? 'alert' : 'check'"
        @dismiss="noRoomToast ? hideNotesForOutline() : dismissToast()"
      />
    </div>
    <HomeScreen
      v-if="(!session || choosingBook) && !openingVisible && !openingError"
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
      v-if="(!session || choosingBook) && (openingVisible || openingError)"
      class="opening-shell"
      data-test="opening-shell"
    >
      <OpeningProgress
        v-if="openingVisible && opening"
        :title="opening.title"
        :found="opening.found"
        :progress="opening.progress"
      />
      <div v-else-if="openingError" role="alert" aria-live="assertive" data-test="opening-error">
        <ErrorCard
          :icon="errorCardIcon(openingError.code)"
          :tone="openingError.tone"
          :title="openingError.title"
          :text="openingError.message"
          :action="openingError.actionLabel"
          @action="onOpeningErrorAction"
        />
      </div>
    </div>
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
      :class="workspaceGridClass"
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
        :numbering-style="session.numberingStyle.value"
        @select="selectedId = $event"
        @activate="focusEditor"
        @numbering-style="onNumberingStyle"
      />
      <OutlineRail v-show="!navigatorOpen && !focusMode" @expand="outlineAuto.toggleByHand()" />
      <ContinuousManuscript
        ref="editorPane"
        :outline="session.outline.value"
        :sections="session.sections"
        :selected-id="selectedId"
        :reload-token="reloads"
        :readonly="session.closed || restoreInProgress"
        :read-only-reason="restoreInProgress ? 'restore in progress' : undefined"
        :navigator-open="navigatorOpen"
        :navigator-controls="chapterNavControls"
        :chapter-title="selected?.title"
        :section-labels="sectionLabels"
        :book-docs="outlineDocs(session.outline.value, session.sections)"
        :chapter-docs="
          selectedId
            ? sectionTreeDocs(session.outline.value, selectedId, session.sections)
            : undefined
        "
        :save-state="saveStatus"
        :author-labels="markAuthorLabel"
        toolbar-target="#toolbar-row"
        external-load-error
        :outline-forced="outlineForced"
        :notes-hidden="notesHidden"
        :computer-name="info?.computerName"
        :decision-records-by-section="decisionRecordsBySection"
        @update:selected-id="selectedId = $event"
        @load-error="editorLoadError = $event"
        @reload="reloadSection"
        @toggle-navigator="outlineAuto.toggleByHand()"
        @decisions="onSectionDecisions"
        @layout="onEditorLayout"
        @focus-mode="focusMode = $event"
        @ask-bot="onAskBotFromEditor"
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
.opening-shell {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ct-space-8);
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
  gap: var(--ct-space-2);
  padding: var(--ct-space-2) var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-surface);
  -webkit-app-region: drag;
}
.topbar__brand {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  min-width: 0;
  flex: 1;
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
  margin-right: 0;
}
.btn,
.topbar__menu {
  position: relative;
  flex: none;
  -webkit-app-region: no-drag;
}
.topbar__trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ct-space-1);
  box-sizing: border-box;
  min-width: var(--ct-space-10);
  min-height: var(--ct-space-10);
  list-style: none;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: var(--ct-text-muted);
  cursor: pointer;
}
.topbar__trigger::-webkit-details-marker {
  display: none;
}
.topbar__hamburger {
  color: var(--ct-text-muted);
}
.topbar__menu-list.sh-menu {
  position: absolute;
  left: 0;
  z-index: 20;
  width: 240px;
  white-space: nowrap;
}
.sh-mi-lead {
  display: inline-flex;
  width: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.app-menu-icon {
  color: var(--ct-text-muted);
}
.topbar__recent {
  position: relative;
}
.topbar__submenu {
  top: 0;
  left: 100%;
  margin-left: var(--ct-space-1);
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
