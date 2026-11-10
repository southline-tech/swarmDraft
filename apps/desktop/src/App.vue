<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue';
import {
  createBackup,
  getAppInfo,
  restoreBackup,
  getRecoveryNotices,
  dismissRecoveryNotices,
  getMigrationNotices,
  dismissMigrationNotices,
  listManuscripts,
  peekResumeManuscript,
  loadManuscript,
  createBlankManuscript,
  listenOpeningProgress,
  manuscriptReviewDecisions,
  saveSectionReviewDecisions,
  sectionCommentReply,
  sectionCommentResolve,
  type AppInfo,
  type OpeningProgressEvent,
  type RecoveryNotice,
  type MigrationNotice,
  type StoredManuscriptRow,
  draftOpen,
  draftOpenPath,
  draftRecoverWorktreeToFile,
  draftAfterWordImport,
  listenOpenDraftPath,
  listenMacosQuit,
  macosQuitCancelled,
  draftTakeLaunchPath,
  draftSave,
  draftSaveAs,
  draftCheckpoint,
  draftReviewCommit,
  type OpenDraftResult,
} from './backend';
import HistoryPanel from './history/HistoryPanel.vue';
import SettingsScreen from './settings/SettingsScreen.vue';
import AgentsWindow from './agents/AgentsWindow.vue';
import { agentDirectory, markAuthorLabel, refreshAgents, reloadOnFocus } from './agent-names';
import type { Agent } from './backend';
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
import { appShell, PRODUCT_NAME, opening as openingDeck } from './copy-deck';
import ShellsPreview from './shells/ShellsPreview.vue';
import Rad60ReviewEvidence from './evidence/Rad60ReviewEvidence.vue';
import Rad67EditorChromeEvidence from './evidence/Rad67EditorChromeEvidence.vue';
import Rad55FocusModeEvidence from './evidence/Rad55FocusModeEvidence.vue';
import Rad304ChapterEvidence from './evidence/Rad304ChapterEvidence.vue';
import Rad36WpEvidence from './evidence/Rad36WpEvidence.vue';
import Rad38NotesEvidence from './evidence/Rad38NotesEvidence.vue';
import Rad34InstallEvidence from './evidence/Rad34InstallEvidence.vue';
import Rad310UpdateEvidence from './evidence/Rad310UpdateEvidence.vue';
import Rad3441PilotEvidence from './evidence/Rad3441PilotEvidence.vue';
import { readEvidenceQuery } from './evidence/evidence-routes';
import AppToast from './shells/AppToast.vue';
import UpdatePromptToast from './updater/UpdatePromptToast.vue';
import {
  createAppUpdater,
  defaultUpdaterDeps,
  initialUpdatePromptState,
  type AppUpdaterHandle,
  type UpdatePromptState,
} from './updater/app-updater';
import { updatePromptEscapeAction } from './updater/update-prompt-logic';
import MergeChapterConfirm from './chapter/MergeChapterConfirm.vue';
import { chapterNeighbors } from './chapter/chapter-editor';
import {
  CHAPTER_TOAST_MS,
  chapterToastUndoDisabled,
  chapterToastUndoHint,
  runChapterMerge,
  runChapterSplit,
  shouldConfirmMerge,
  undoChapterToast,
  type ChapterToastState,
} from './chapter/chapter-app-handlers';
import { appMenuKeyAction, menuShortcutLabel, saveChord } from './shells/app-shortcuts';
import OpeningProgress from './shells/OpeningProgress.vue';
import ErrorCard from './shells/ErrorCard.vue';
import PairingPrompt from './PairingPrompt.vue';
import FeedbackPrompt from './FeedbackPrompt.vue';
import SendFeedbackModal from './SendFeedbackModal.vue';
import OverlayAnchoredMenu from './overlay/OverlayAnchoredMenu.vue';
import {
  OPENING_REVEAL_MS,
  errorCardIcon,
  openingStateFromEvent,
  openingTitleAfterImport,
  openingUiForImport,
  openingUiForStoredOpen,
  titleFromDocxName,
  type OpeningRetry,
  type OpeningUiState,
} from './errors/opening-flow';
import { ImportCancelledError } from './import/import-cancelled';
import { useDeferredValue } from './a11y/deferred';
import './shells/shells.css';
import { applyThemeParam, readPreview } from './shells/preview';
import { CLOSE_FLUSH_TIMEOUT_MS, confirmQuit, flushOnClose, flushWithTimeout } from './close-flush';
import { loadReadingPosition, saveReadingPosition, type ReadingPosition } from './reading-position';
import {
  shouldShowImportHome,
  startupResumeAfterReopen,
  type StartupResumePhase,
} from './startup-resume';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { resetCollabSlots } from './author-colors';
import { sectionNumberLabels } from '@swarmdraft/editor';
import type { NumberingStyle } from '@swarmdraft/schema';
import type { DecisionRecord } from '@swarmdraft/editor';
import { mergeLoadedDecisionRecords } from './review/decision-records-load';
import { docWordCount, outlineDocs, sectionTreeDocs } from './status/wordcount';
import type { ManuscriptSaveView } from './status/save-status';
import StatusBar from './status/StatusBar.vue';
import { APP_FOOTER_EDITOR_KEY, type AppFooterEditorState } from './status/app-footer';
import {
  importAndOpen,
  openStored,
  reopenLatest,
  UnsavedEditsError,
  type ManuscriptSession,
} from './manuscript-session';
import StoryNotesSheet from './notes/StoryNotesSheet.vue';
import { openNotesSession, type NotesSession } from './notes/useNotesSession';
import { loadProfile } from './settings/prefs';

const info = ref<AppInfo | null>(null);
const updatePrompt = ref<UpdatePromptState>(initialUpdatePromptState());
let appUpdater: AppUpdaterHandle | undefined;
const session = shallowRef<ManuscriptSession | null>(null);
const notesSession = shallowRef<NotesSession | null>(null);
/** #38: story notes dock under the editor; off until the writer opens them from the book menu. */
const storyNotesOpen = ref(false);
const storyNotesSheetHeight = ref(0);
let storyNotesOpener: HTMLElement | null = null;
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
const startupResume = ref<StartupResumePhase>(isTauri() ? 'pending' : 'done');
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
  opening.value = openingUiForStoredOpen(title);
  openingRevealTimer = setTimeout(() => {
    if (opening.value) openingVisible.value = true;
  }, OPENING_REVEAL_MS);
}
function startImportOpening(title: string) {
  clearTimeout(openingRevealTimer);
  openingError.value = null;
  opening.value = openingUiForImport(title);
  openingVisible.value = true;
}
/** Monotonic id so an older import's cleanup cannot clear a newer job's cancel handle (#306). */
let importJobSeq = 0;
let importAbort: AbortController | undefined;
function cancelImportOpening() {
  const job = importJobSeq;
  importAbort?.abort();
  if (importJobSeq !== job) return;
  importing.value = false;
  finishOpening();
  importAbort = undefined;
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
  openError.value = '';
  openingError.value = mapError(err, context);
}
function unsavedImportError(fileName: string): MappedError {
  return {
    code: 'save-failed',
    title: "Edits aren't saved yet",
    message: `Couldn't import ${fileName} yet. Your current book has edits that aren't saved — wait a moment and try again.`,
    action: 'dismiss',
    actionLabel: 'Got it',
    tone: 'warning',
  };
}
let openingErrorReturnFocus: HTMLElement | null = null;
watch(openingError, (err, prev) => {
  if (err && !prev) {
    const el = document.activeElement;
    openingErrorReturnFocus = el instanceof HTMLElement ? el : null;
  }
});
const openingErrorShown = useDeferredValue(openingError);
function restoreOpeningErrorFocus() {
  const el = openingErrorReturnFocus;
  openingErrorReturnFocus = null;
  void nextTick(() => {
    el?.focus?.();
  });
}
function dismissOpeningError() {
  restoreOpeningErrorFocus();
  finishOpening();
}
const showOpeningShell = computed(
  () =>
    startupResume.value === 'pending' ||
    !!openingError.value ||
    (openingVisible.value && (!session.value || choosingBook.value || importing.value)),
);
const showImportHome = computed(() =>
  shouldShowImportHome(
    startupResume.value,
    !!session.value,
    choosingBook.value,
    showOpeningShell.value,
  ),
);
const openingShellOverlay = computed(
  () => !!session.value && !choosingBook.value && (importing.value || !!openingError.value),
);
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
  if (err.action === 'dismiss') {
    dismissOpeningError();
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
  if (retry.kind === 'create-blank') {
    await onToolbarDraftNew();
    return;
  }
  if (retry.kind === 'import') await importBytes(retry.name, retry.bytes);
}
/** Save-failure banner state (#62, ob9): shown while edits are unsaved; cleared once a save
 * succeeds. Edits are never dropped. Raw error text only goes to the console. */
const saveFailure = ref({ ...SAVE_OK });
const saveError = computed(() => saveFailure.value.failing);
/** RAD-265 / #204: footer save line after at least one successful persist. */
const saveStatusShown = ref(false);
const saveDirty = ref(false);
const lastSavedAt = ref<number | null>(null);
/** Manuscript id for the in-flight save callbacks (ignore stale flushes after switch). */
const saveHookManuscriptId = ref<string | undefined>();
const persistHooks = {
  onError: (err: unknown) => {
    console.error('Save failed; retrying', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  },
  onDirty: () => {
    saveDirty.value = true;
    saveHookManuscriptId.value = session.value?.id;
  },
  onSaved: () => {
    if (session.value?.id !== saveHookManuscriptId.value) return;
    saveFailure.value = saveSucceeded();
    saveDirty.value = false;
    lastSavedAt.value = Date.now();
    saveStatusShown.value = true;
    const id = session.value?.id;
    const title =
      session.value?.outline.value.find((s) => s.id === selectedId.value)?.title ?? 'chapter';
    if (id && isTauri()) {
      void draftCheckpoint(id, `Edited ${title}`).catch((err) => {
        console.error('Draft checkpoint failed', err);
        saveFailure.value = saveFailed(saveFailure.value, err);
      });
    }
  },
};
const manuscriptSave = computed((): ManuscriptSaveView | undefined => {
  if (!session.value || choosingBook.value) return undefined;
  if (saveError.value) {
    return { phase: 'error', message: '' };
  }
  if (saveDirty.value) return { phase: 'saving' };
  if (saveStatusShown.value && lastSavedAt.value != null) {
    return { phase: 'saved', savedAt: lastSavedAt.value };
  }
  return { phase: 'idle' };
});
function onManuscriptSaveRetry() {
  void session.value?.flush();
}
const saveCopyRelinkOffer = ref(false);
const saveCopyOfOpen = () =>
  session.value ? saveCopy(session.value) : Promise.resolve({ status: 'cancelled' as const });
async function onSaveCopyRelink() {
  await onMenuSaveAs();
  saveCopyRelinkOffer.value = false;
}
async function onSaveCopyWithOffer() {
  const r = await saveCopyOfOpen();
  if (r.status === 'saved' && saveFailure.value.failing) {
    saveCopyRelinkOffer.value = true;
  }
  return r;
}
/**
 * Bumped by the editor's Reload action to reopen the section from its Y.Doc. The editor is bound
 * to that doc, so everything typed is already in it and survives the remount (and switching
 * sections). The remount is a fresh editor, so its undo history is lost; nothing typed while the
 * editor was read-only after a content error was ever accepted, so there is nothing else to lose.
 */
const reloads = ref(0);
/** Refetch review comment rows without remounting section editors (#255). */
const commentMetaVersion = ref(0);
const chapterToast = ref<ChapterToastState | null>(null);
let chapterToastTimer: ReturnType<typeof setTimeout> | undefined;
let chapterToastDeadline = 0;
const mergePending = ref<{
  targetId: string;
  sourceId: string;
  targetTitle: string;
  sourceTitle: string;
} | null>(null);
const mergeSkipConfirmSession = ref(false);
const splitChapterHintId = ref<string | null>(null);
const splitAcrossThreadIds = ref<string[]>([]);
const chapterToastUndoBlocked = computed(() => {
  const s = session.value;
  const t = chapterToast.value;
  if (!s || !t) return false;
  return chapterToastUndoDisabled(s, t);
});
function scheduleChapterToast(toast: ChapterToastState) {
  chapterToast.value = toast;
  clearTimeout(chapterToastTimer);
  chapterToastDeadline = Date.now() + CHAPTER_TOAST_MS;
  chapterToastTimer = setTimeout(() => {
    chapterToast.value = null;
  }, CHAPTER_TOAST_MS);
}

function pauseChapterToastTimer() {
  if (!chapterToast.value) return;
  clearTimeout(chapterToastTimer);
  chapterToastTimer = undefined;
}

function resumeChapterToastTimer() {
  if (!chapterToast.value || chapterToastTimer) return;
  const remaining = chapterToastDeadline - Date.now();
  if (remaining <= 0) {
    chapterToast.value = null;
    return;
  }
  chapterToastTimer = setTimeout(() => {
    chapterToast.value = null;
  }, remaining);
}

function onChapterToastFocusOut(e: FocusEvent) {
  const root = e.currentTarget;
  if (
    root instanceof HTMLElement &&
    e.relatedTarget instanceof Node &&
    root.contains(e.relatedTarget)
  ) {
    return;
  }
  resumeChapterToastTimer();
}
async function onEditorSplitChapter(payload: {
  blockIndex: number;
  title: string;
  removeLine: boolean;
}) {
  const s = session.value;
  const chapterId = selectedId.value;
  if (!s || !chapterId) return;
  const result = await runChapterSplit(
    s,
    s.id,
    chapterId,
    payload,
    chapterId,
    notesSession.value?.doc,
  );
  selectedId.value = result.newChapterId;
  splitChapterHintId.value = null;
  splitAcrossThreadIds.value = result.splitAcrossThreadIds;
  scheduleChapterToast(result.toast);
  void nextTick(() => editorPane.value?.focusSection(result.newChapterId));
}
async function commitChapterMerge(targetId: string, sourceId: string) {
  const s = session.value;
  if (!s || !selectedId.value) return;
  const result = await runChapterMerge(
    s,
    targetId,
    sourceId,
    selectedId.value,
    notesSession.value?.doc,
  );
  selectedId.value = result.targetId;
  scheduleChapterToast(result.toast);
  mergePending.value = null;
}
function requestChapterMerge(targetId: string, sourceId: string) {
  const s = session.value;
  if (!s) return;
  const target = s.outline.value.find((x) => x.id === targetId);
  const source = s.outline.value.find((x) => x.id === sourceId);
  if (!target || !source) return;
  if (shouldConfirmMerge(s, sourceId, mergeSkipConfirmSession.value)) {
    mergePending.value = {
      targetId,
      sourceId,
      targetTitle: target.title || 'Untitled',
      sourceTitle: source.title || 'Untitled',
    };
    return;
  }
  void commitChapterMerge(targetId, sourceId);
}
function onMergeClose() {
  mergePending.value = null;
  const id = selectedId.value;
  if (id) void nextTick(() => editorPane.value?.focusSection(id));
}

async function onMergeConfirm(dontAsk: boolean) {
  if (dontAsk) mergeSkipConfirmSession.value = true;
  const p = mergePending.value;
  if (!p) return;
  await commitChapterMerge(p.targetId, p.sourceId);
}
async function undoChapterAction() {
  const s = session.value;
  const t = chapterToast.value;
  if (!s || !t || chapterToastUndoBlocked.value) return;
  selectedId.value = await undoChapterToast(s, t, notesSession.value?.doc);
  chapterToast.value = null;
  clearTimeout(chapterToastTimer);
}
function dismissChapterToast() {
  chapterToast.value = null;
  clearTimeout(chapterToastTimer);
}
function onOutlineSplitChapter(id: string) {
  selectedId.value = id;
  splitChapterHintId.value = id;
  void nextTick(() => editorPane.value?.focusSection(id));
}
function onEditorMergePrev() {
  const s = session.value;
  const id = selectedId.value;
  if (!s || !id) return;
  const { prev } = chapterNeighbors(s.outline.value, id);
  if (!prev) return;
  requestChapterMerge(prev.id, id);
}
const leadChapterOps = computed(() => {
  const s = session.value;
  const id = selectedId.value;
  if (!s || !id) return null;
  const sec = s.outline.value.find((x) => x.id === id);
  if (sec?.kind !== 'chapter') return null;
  const n = chapterNeighbors(s.outline.value, id);
  return {
    chapterNumber: n.index + 1,
    canMergePrev: !!n.prev,
    splitHint: splitChapterHintId.value === id,
  };
});
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
function onSectionDecisions(
  sectionId: string,
  records: DecisionRecord[],
  suggestionAuthor?: string,
) {
  if (!session.value) return;
  const prev = decisionRecordsBySection.value[sectionId] ?? [];
  decisionRecordsBySection.value = { ...decisionRecordsBySection.value, [sectionId]: records };
  void saveSectionReviewDecisions(session.value.id, sectionId, records)
    .then(async () => {
      if (!isTauri() || records.length <= prev.length) return;
      const latest = records[records.length - 1];
      if (!latest) return;
      await session.value?.flush();
      const chapter =
        session.value?.outline.value.find((s) => s.id === sectionId)?.title ?? 'chapter';
      const botName = suggestionAuthor || 'editor';
      await draftReviewCommit({
        manuscriptId: session.value!.id,
        accepted: latest.status === 'accepted',
        botName,
        chapterTitle: chapter,
        botAgentId: agentIdFromSuggestionAuthor(suggestionAuthor),
      }).catch((err) => console.error('Draft review commit failed', err));
    })
    .catch((err) => {
      console.error('Review decision save failed; next change will retry', err);
      saveFailure.value = saveFailed(saveFailure.value, err);
    });
}
async function onCommentReply(sectionId: string, threadId: string, body: string) {
  if (!session.value) return;
  const profile = loadProfile();
  try {
    await sectionCommentReply(session.value.id, sectionId, threadId, body, profile.name, 'local');
    commentMetaVersion.value++;
  } catch (err) {
    console.error('Comment reply save failed', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  }
}
async function onCommentResolve(sectionId: string, threadId: string, resolved: boolean) {
  if (!session.value) return;
  try {
    await sectionCommentResolve(session.value.id, sectionId, threadId, resolved);
    commentMetaVersion.value++;
  } catch (err) {
    console.error('Comment resolve save failed', err);
    saveFailure.value = saveFailed(saveFailure.value, err);
  }
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
const WELCOMED_KEY = 'swarmdraft.welcomed';
const LEGACY_WELCOMED_KEY = 'coauthor.welcomed';
const welcomed = ref(readWelcomed());
function readWelcomed(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (ls?.getItem(WELCOMED_KEY) === '1') return true;
    if (ls?.getItem(LEGACY_WELCOMED_KEY) === '1') {
      ls?.setItem(WELCOMED_KEY, '1');
      return true;
    }
    return false;
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
const feedbackOpen = ref(false);
const feedbackFocusReturn = ref<HTMLElement | null>(null);
const feedbackExcerpt = ref<string | null>(null);
const agentsOpen = ref(false);
const newlyPairedAgentIds = ref<string[]>([]);
const agentsBatchBanner = computed(() => newlyPairedAgentIds.value.length >= 5);
const agentsForWindow = computed(() => {
  const dir = agentDirectory.value;
  if (!dir) return [] as Agent[];
  return [...dir.values()];
});
function onPairingApproved(agent: Agent) {
  newlyPairedAgentIds.value = [...newlyPairedAgentIds.value, agent.id].slice(-5);
  void refreshAgents();
}
function dismissAgentsBatch() {
  newlyPairedAgentIds.value = [];
}
const draftPickerLabel = computed(() => session.value?.title?.trim() || 'Untitled draft');
function openToolbarSettings() {
  settingsFocusReturn.value =
    document.querySelector<HTMLElement>('[data-test="toolbar-settings"]') ?? null;
  settingsOpen.value = true;
}
function openFeedback(from?: HTMLElement | null) {
  feedbackFocusReturn.value =
    from ??
    document.querySelector<HTMLElement>('[data-test="toolbar-settings"]') ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  feedbackExcerpt.value = editorPane.value?.feedbackExcerpt?.()?.trim() || null;
  feedbackOpen.value = true;
}
function closeFeedbackModal() {
  feedbackOpen.value = false;
  void nextTick(() => {
    feedbackFocusReturn.value?.focus();
    feedbackFocusReturn.value = null;
  });
}
function openToolbarAgents() {
  agentsFocusReturn.value =
    document.querySelector<HTMLElement>('[data-test="toolbar-agents"]') ?? null;
  void refreshAgents();
  void refreshDraftRows();
  agentsOpen.value = true;
}
function closeAgentsWindow() {
  agentsOpen.value = false;
  void nextTick(() => {
    agentsFocusReturn.value?.focus();
    agentsFocusReturn.value = null;
  });
}
function openAgentsSettingsFromWindow() {
  agentsOpen.value = false;
  settingsOpen.value = true;
}
function onToolbarDraftImport() {
  chooseFile();
}
function sortDraftsNewestFirst(rows: StoredManuscriptRow[]) {
  return [...rows].sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });
}
const draftRows = ref<StoredManuscriptRow[]>([]);
async function refreshDraftRows() {
  try {
    const books = await listManuscripts();
    recentBooks.value = books;
    draftRows.value = sortDraftsNewestFirst(books);
  } catch (e) {
    console.error('List manuscripts failed', e);
    recentBooks.value = [];
    draftRows.value = [];
  }
}
function onToolbarDraftMenuOpen() {
  void refreshDraftRows();
}
async function onToolbarDraftNew() {
  if (creatingBlankDraft.value) return;
  creatingBlankDraft.value = true;
  openingRetry.value = { kind: 'create-blank', title: 'Untitled draft' };
  startOpening('Untitled draft');
  try {
    try {
      await session.value?.flush();
    } catch (e) {
      console.error('Flush before new draft failed', e);
      finishOpening();
      openError.value = `Couldn't save the open draft: ${errorLine(e, 'save')}`;
      return;
    }
    openError.value = '';
    const stored = await createBlankManuscript();
    if (!stored) {
      failOpening('create blank draft failed', 'open');
      return;
    }
    const next = openStored(stored, null, persistHooks);
    finishOpening();
    open(next);
    showOpenToast(next);
    await refreshDraftRows();
    const titleSec =
      next.outline.value.find((s) => s.kind === 'front_matter' && s.title === 'Title page') ??
      next.outline.value[0];
    if (titleSec) {
      selectedId.value = titleSec.id;
      await nextTick();
      editorPane.value?.focusSection(titleSec.id);
    }
  } catch (e) {
    console.error('New blank draft failed', e);
    failOpening(e, 'open');
  } finally {
    creatingBlankDraft.value = false;
  }
}
function onToolbarDraftSelect(id: string) {
  void openRecentBook(id);
}
// UI-shell previews (Part of #36): `?preview=<id|all>`, or Settings → Preview new screens.
applyThemeParam(window.location.search, document.documentElement);
const evidence = ref(readEvidenceQuery(window.location.search));
onMounted(() => {
  if (evidence.value !== '34-c6') return;
  try {
    globalThis.localStorage?.setItem('swarmdraft.welcomed', '1');
  } catch {
    /* storage blocked in some test envs */
  }
  const theme = new URLSearchParams(location.search).get('theme');
  location.replace(theme ? `/?theme=${theme}` : '/');
});
const preview = ref(readPreview(window.location.search));
function openPreview(id: 'all') {
  settingsOpen.value = false;
  preview.value = id;
}
const settingsButton = ref<HTMLButtonElement | null>(null);
const settingsFocusReturn = shallowRef<HTMLElement | null>(null);
const agentsFocusReturn = shallowRef<HTMLElement | null>(null);
const recentOpen = ref(false);
const recentBooks = ref<StoredManuscriptRow[]>([]);
const creatingBlankDraft = ref(false);
async function refreshRecentBooks() {
  await refreshDraftRows();
}
const appMenu = ref<HTMLDetailsElement | null>(null);
const bookMenuOpen = ref(false);
const historyOpen = ref(false);
const bookMenuTrigger = shallowRef<HTMLElement | null>(null);
const recentTrigger = shallowRef<HTMLButtonElement | null>(null);
function closeBookMenu() {
  appMenu.value?.removeAttribute('open');
  bookMenuOpen.value = false;
  recentOpen.value = false;
}

function onBookMenuKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeBookMenu();
  bookMenuTrigger.value?.focus();
}

function onRecentMenuKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  recentOpen.value = false;
  recentTrigger.value?.focus();
}
function onAppMenuToggle(e: Event) {
  const open = (e.target as HTMLDetailsElement).open;
  bookMenuOpen.value = open;
  if (open) void refreshRecentBooks();
  else recentOpen.value = false;
}
function agentIdFromSuggestionAuthor(author?: string): string | undefined {
  if (!author?.startsWith('agent:')) return undefined;
  const id = author.slice('agent:'.length).trim();
  return id || undefined;
}

async function resolveDraftRecovery(result: OpenDraftResult): Promise<OpenDraftResult | null> {
  if (!result.recovery) return result;
  const saveNewer = window.confirm(
    'This book on your device is newer than the file on disk. Save the newer version to the file before opening?',
  );
  if (saveNewer) {
    await draftRecoverWorktreeToFile(result.recovery.manuscriptId);
    return draftOpenPath(result.recovery.draftPath, false);
  }
  return draftOpenPath(result.recovery.draftPath, true);
}

async function openManuscriptFromDraftResult(result: OpenDraftResult) {
  let resolved = result;
  for (let i = 0; i < 3 && resolved.recovery; i += 1) {
    const next = await resolveDraftRecovery(resolved);
    if (!next) return;
    resolved = next;
  }
  const id = resolved.manuscriptId;
  if (session.value?.id === id) {
    await reloadOpenManuscript();
    closeBookMenu();
    await refreshDraftRows();
    return;
  }
  await session.value?.flush().catch((e) => {
    console.error('Flush before open failed', e);
    throw e;
  });
  const stored = await loadManuscript(id);
  if (!stored) {
    openError.value = "Couldn't open that draft.";
    return;
  }
  const next = openStored(stored, null, persistHooks);
  open(next);
  showOpenToast(next);
  closeBookMenu();
  await refreshDraftRows();
}

async function openDraftFromPath(path: string) {
  if (!isTauri()) return;
  openError.value = '';
  try {
    const result = await draftOpenPath(path, false);
    if (!result) return;
    await openManuscriptFromDraftResult(result);
  } catch (e) {
    console.error('Open draft path failed', e);
    openError.value = errorLine(e, 'open');
  }
}

async function openDraftFromDialog() {
  if (!isTauri()) {
    openBookPicker();
    return;
  }
  openError.value = '';
  try {
    const result = await draftOpen(false);
    if (!result) return;
    await openManuscriptFromDraftResult(result);
  } catch (e) {
    console.error('Open draft failed', e);
    openError.value = errorLine(e, 'open');
  }
}

function openBookPicker() {
  if (session.value) choosingBook.value = true;
  else void getStarted();
}

/**
 * Retry section persist, then write the draft file. A failed flush used to stop before
 * `draftSave` / `draftSaveAs`, so Ctrl+S in the error state only refreshed the same banner.
 * If the retry still can't persist, show the plain save warning and skip the file write.
 */
async function flushForDraftSave(): Promise<boolean> {
  if (!session.value) return false;
  try {
    await session.value.flush();
    return true;
  } catch (e) {
    console.error('Save draft failed', e);
    saveFailure.value = saveFailed(saveFailure.value, e);
    return false;
  }
}

async function onMenuSave() {
  if (!session.value || !isTauri()) return;
  closeBookMenu();
  if (!(await flushForDraftSave())) return;
  try {
    const outcome = await draftSave(session.value.id);
    if (outcome.status === 'needsSaveAs') {
      await onMenuSaveAs();
      return;
    }
    saveFailure.value = saveSucceeded();
  } catch (e) {
    console.error('Save draft failed', e);
    saveFailure.value = saveFailed(saveFailure.value, e);
  }
}

/** Second Save As while the picker or write is in flight is ignored; always cleared in `finally`. */
let saveAsBusy = false;

async function onMenuSaveAs() {
  if (!session.value || !isTauri()) return;
  if (saveAsBusy) return;
  saveAsBusy = true;
  closeBookMenu();
  try {
    if (!(await flushForDraftSave())) return;
    const path = await draftSaveAs(session.value.id);
    if (path) {
      saveFailure.value = saveSucceeded();
      saveCopyRelinkOffer.value = false;
      await refreshDraftRows();
    }
  } catch (e) {
    console.error('Save As failed', e);
    saveFailure.value = saveFailed(saveFailure.value, e);
  } finally {
    saveAsBusy = false;
  }
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
    await refreshDraftRows();
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
  const flushed = await flushWithTimeout(
    () => session.value?.flush() ?? Promise.resolve(),
    CLOSE_FLUSH_TIMEOUT_MS,
  );
  if (flushed !== 'saved' && !(await confirmQuit())) {
    await macosQuitCancelled();
    return;
  }
  try {
    await win.destroy();
  } catch (e) {
    await macosQuitCancelled();
    throw e;
  }
}
watch(settingsOpen, async (isOpen) => {
  await nextTick();
  if (!isOpen) {
    (settingsFocusReturn.value ?? settingsButton.value)?.focus();
    settingsFocusReturn.value = null;
  }
});
const fileInput = ref<HTMLInputElement | null>(null);
const chooseFile = () => {
  openError.value = '';
  fileInput.value?.click();
};

/** Book-menu shortcuts wired in this build (#104 Designer). */
const appMenuShortcuts = computed(() => ({
  new: importing.value ? undefined : menuShortcutLabel('Ctrl+N'),
  open: menuShortcutLabel('Ctrl+O'),
  importWord: menuShortcutLabel('Ctrl+Shift+O'),
  save: session.value && isTauri() ? menuShortcutLabel('Ctrl+S') : undefined,
  saveAs: session.value && isTauri() ? menuShortcutLabel('Ctrl+Shift+S') : undefined,
  settings: menuShortcutLabel('Ctrl+,'),
  quit: isTauri() ? menuShortcutLabel('Ctrl+Q') : undefined,
}));

const menuTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select');

const menuField = (t: EventTarget | null) =>
  menuTextField(t) || (t instanceof HTMLElement && !!t.closest('[contenteditable=true]'));

/** Ctrl+S / Ctrl+Shift+S (Command on macOS) save the book from the editor. They stay inert in text fields. */
function isSaveChord(e: KeyboardEvent) {
  return saveChord(e, !!session.value && isTauri());
}

function onUpdatePromptEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || menuField(e.target)) return;
  const action = updatePromptEscapeAction(updatePrompt.value.mode);
  if (action === 'later') {
    e.preventDefault();
    onUpdateLater();
  } else if (action === 'dismiss') {
    e.preventDefault();
    onUpdateDismissManual();
  }
}

function onAppMenuKey(e: KeyboardEvent) {
  if (preview.value) return;
  // The editor is contenteditable, but Save must still run while the failure banner is up (#336).
  if (menuField(e.target) && !(isSaveChord(e) && !menuTextField(e.target))) return;
  const action = appMenuKeyAction(e, {
    importing: importing.value,
    canSave: !!session.value && isTauri(),
    canQuit: isTauri(),
  });
  if (!action) return;
  e.preventDefault();
  if (action === 'import-word') {
    if (!importing.value) chooseFile();
  } else if (action === 'save-as') void onMenuSaveAs();
  else if (action === 'new') void onToolbarDraftNew();
  else if (action === 'open') void openDraftFromDialog();
  else if (action === 'save') void onMenuSave();
  else if (action === 'settings') settingsOpen.value = !settingsOpen.value;
  else if (action === 'quit') void quitApp();
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
let stopOpenDraftPath = () => {};
let stopMacosQuit = () => {};
let leaving = false;
onMounted(() => {
  window.addEventListener('dragover', blockFileNavigation);
  window.addEventListener('drop', blockFileNavigation);
  window.addEventListener('focus', reloadAgents);
  window.addEventListener('keydown', onAppMenuKey);
  window.addEventListener('keydown', onUpdatePromptEscape);
  void refreshAgents();
  // Register the listener before taking the queue. take_all marks the slot taken;
  // a Finder open that arrives in the gap would be emitted with nobody listening.
  void (async () => {
    const unlisten = await listenOpenDraftPath((path) => {
      void openDraftFromPath(path);
    });
    if (leaving) {
      unlisten();
      return;
    }
    stopOpenDraftPath = unlisten;
    const path = await draftTakeLaunchPath();
    if (!leaving && path) void openDraftFromPath(path);
  })();
  void listenMacosQuit(() => {
    void quitApp();
  }).then((unlisten) => {
    if (leaving) unlisten();
    else stopMacosQuit = unlisten;
    // A quit that arrived before this listener is dropped. Clear the gate so the next one flushes.
    void macosQuitCancelled();
  });
  stopAppMenuKeys = () => {
    window.removeEventListener('keydown', onAppMenuKey);
    window.removeEventListener('keydown', onUpdatePromptEscape);
  };
});
onBeforeUnmount(() => {
  leaving = true;
  window.removeEventListener('dragover', blockFileNavigation);
  window.removeEventListener('drop', blockFileNavigation);
  window.removeEventListener('focus', reloadAgents);
  stopAppMenuKeys();
  stopOpenDraftPath();
  stopMacosQuit();
  appUpdater?.dispose();
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
        const resume = await peekResumeManuscript();
        const t = resume?.title?.trim();
        if (t) reopenTitle = t;
      } catch (e) {
        console.error('Peek resume manuscript before reopen failed', e);
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
    } finally {
      startupResume.value = startupResumeAfterReopen();
    }
  } else {
    startupResume.value = 'done';
  }
  stopCloseFlush = await flushOnClose(async () => {
    persistReadingPositionForClose();
    await (session.value?.flush() ?? Promise.resolve());
  });
  if (isTauri()) {
    appUpdater = createAppUpdater(defaultUpdaterDeps(), (s) => {
      updatePrompt.value = s;
    });
    appUpdater.scheduleAutoCheck();
  }
});

async function checkForUpdatesManual() {
  closeBookMenu();
  await appUpdater?.manualCheck();
}

async function installUpdateNow() {
  await appUpdater?.installPending(() => session.value?.flush() ?? Promise.resolve());
}

function onUpdateLater() {
  appUpdater?.later();
}

function onUpdateDismissManual() {
  appUpdater?.dismissManual();
}

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
  void notesSession.value?.close({ discard: true });
  session.value = null;
  notesSession.value = null;
  storyNotesOpen.value = false;
  saveStatusShown.value = false;
  saveDirty.value = false;
  lastSavedAt.value = null;
  decisionRecordsBySection.value = {};
  selectedId.value = undefined;
  choosingBook.value = false;
  syncWindowTitle(PRODUCT_NAME);
}

/** Open an imported manuscript (exposed for tests and the Tauri open-file flow). */
/** A rejected close keeps that session open and retrying; just log it. */
const closeQuietly = (s?: ManuscriptSession | null) =>
  void s?.close().catch((err: unknown) => console.error('Edits not saved yet; retrying', err));

async function onHistoryBeforeRestore() {
  if (!session.value) return;
  try {
    await session.value.flush();
    await draftSave(session.value.id, 'Saved before restore');
  } catch (e) {
    console.error('Pre-restore save failed', e);
    throw e;
  }
}

/** Reload the open book from SQLite after git hydrate (History restore / portable open). */
async function reloadOpenManuscript() {
  const id = session.value?.id;
  if (!id) return;
  await session.value
    ?.close({ discard: true })
    .catch((e) => console.error('Reload close failed', e));
  notesSession.value = null;
  try {
    const stored = await loadManuscript(id);
    if (!stored) {
      openError.value = "Couldn't reload that draft.";
      closeSession();
      return;
    }
    open(openStored(stored, null, persistHooks));
  } catch (e) {
    console.error('Reload manuscript failed', e);
    openError.value = errorLine(e, 'open');
    closeSession();
  }
}

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
  saveDirty.value = false;
  lastSavedAt.value = null;
  // A manuscript is open again, so an earlier "please restart" or open failure no longer holds.
  fatalError.value = '';
  openError.value = '';
  openingError.value = null;
  // Anyone with a book open is past first run: never flash the welcome at them.
  markWelcomed();
  choosingBook.value = false;
  session.value = next;
  notesSession.value = null;
  storyNotesOpen.value = false;
  decisionRecordsBySection.value = {};
  void loadDecisionRecords(next.id);
  syncWindowTitle(next.title || PRODUCT_NAME);
  const rows = next.outline.value;
  const saved = loadReadingPosition(next.id);
  selectedId.value =
    saved?.sectionId && rows.some((s) => s.id === saved.sectionId)
      ? saved.sectionId
      : rows.find((s) => s.kind === 'chapter')?.id;
  void nextTick(() => {
    if (saved) editorPane.value?.restoreReadingPosition(saved);
  });
  void refreshDraftRows();
}

const lastReadingPosition = ref<ReadingPosition | null>(null);
function onReadingPosition(pos: ReadingPosition) {
  lastReadingPosition.value = pos;
  const id = session.value?.id;
  if (id) saveReadingPosition(id, pos);
}
function persistReadingPositionForClose() {
  const id = session.value?.id;
  if (!id || !lastReadingPosition.value) return;
  saveReadingPosition(id, lastReadingPosition.value);
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
  fatalError.value = appShell.reopenFailed(PRODUCT_NAME);
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
const isWordFile = (f: File) => f.name.toLowerCase().split('.').pop() === 'docx';

async function restoreAfterImportCancelled(current?: ManuscriptSession | null) {
  if (current?.closed) {
    await reopenAfterFailure();
    return;
  }
  if (current && !current.closed && session.value === current) current.resumeLive?.();
}

async function importBytes(fileName: string, bytes: Uint8Array) {
  if (importing.value) return;
  openError.value = '';
  openingRetry.value = { kind: 'import', name: fileName, bytes: bytes.slice() };
  startImportOpening(titleFromDocxName(fileName));
  importing.value = true;
  const job = ++importJobSeq;
  const abort = new AbortController();
  importAbort = abort;
  const current = session.value;
  try {
    try {
      const next = await importAndOpen(bytes, persistHooks, current, {
        fileName,
        signal: abort.signal,
        onParsedTitle: (title) => {
          if (opening.value) {
            opening.value = {
              ...opening.value,
              title: openingTitleAfterImport(title, fileName),
            };
          }
        },
        onParsed: (imported) => {
          if (opening.value) {
            const chapters = imported.sections.filter((s) => s.kind === 'chapter').length;
            opening.value = {
              ...opening.value,
              found: chapters,
              indeterminate: true,
            };
          }
        },
      });
      finishOpening();
      open(next);
      showOpenToast(next);
      if (isTauri()) {
        try {
          await draftAfterWordImport(next.id, fileName);
        } catch (e) {
          console.error('Import draft file failed', e);
          saveFailure.value = saveFailed(saveFailure.value, e);
        }
      }
    } catch (err) {
      if (err instanceof ImportCancelledError) {
        await restoreAfterImportCancelled(current);
        finishOpening();
        return;
      }
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
    if (err instanceof ImportCancelledError) {
      await restoreAfterImportCancelled(current);
      finishOpening();
      return;
    }
    console.error('Import failed', err);
    dismissToast();
    openError.value = '';
    if (err instanceof UnsavedEditsError) {
      openingRetry.value = null;
      clearTimeout(openingRevealTimer);
      openingVisible.value = false;
      opening.value = null;
      openingError.value = unsavedImportError(fileName);
    } else {
      failOpening(err, 'import');
    }
  } finally {
    if (importJobSeq === job) {
      importAbort = undefined;
      importing.value = false;
    }
  }
}

async function importFile(file: File) {
  if (importing.value) return;
  if (!isWordFile(file)) {
    openError.value = '';
    failOpening(new Error('Not a valid Word manuscript (zip directory not found)'), 'import');
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.error('Import failed', err);
    dismissToast();
    failOpening(err, 'import');
    return;
  }
  await importBytes(file.name, bytes);
}

const selected = computed(() =>
  session.value?.outline.value.find((s) => s.id === selectedId.value),
);
/** Per-section word counts for the outline (#52): read-only, recounted after edits settle. */
const wordCounts = shallowRef<Record<string, number>>({});
const changeCounts = shallowRef<Record<string, number>>({});
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

const humanNotesAuthor = computed(() => {
  const profile = loadProfile();
  const name = profile.name.trim() || info.value?.computerName || 'Author';
  return { id: `human:${name}`, name };
});
/** Focus mode (#55 / wp5): hides the app chrome; local UI state only. */
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
  return navigatorOpen.value
    ? 'grid-cols-[18rem_minmax(0,1fr)]'
    : 'grid-cols-[var(--ct-rail-w)_minmax(0,1fr)]';
});
/** Footer keeps a usable right column for Story notes toggle (#204 / #207). */
const FOOTER_NOTES_CLOSED_TRACK = 'auto';
const footerColumnTracks = computed(() => {
  if (focusMode.value) return undefined;
  const left = navigatorOpen.value ? '18rem' : 'var(--ct-rail-w)';
  return `${left} minmax(0, 1fr) ${FOOTER_NOTES_CLOSED_TRACK}`;
});
const chapterCount = computed(
  () => session.value?.outline.value.filter((s) => s.kind === 'chapter').length ?? 0,
);
const footerEditor = shallowRef<AppFooterEditorState>({});
provide(APP_FOOTER_EDITOR_KEY, footerEditor);
const wordsBeforeCaretInBook = ref(0);
watch(
  () => session.value?.id,
  () => {
    footerEditor.value = {};
    wordsBeforeCaretInBook.value = 0;
  },
);
function onWordsBeforeCaret(n: number) {
  wordsBeforeCaretInBook.value = n;
}
function onFooterZoom(z: number) {
  if (footerEditor.value.zoom === z) return;
  editorPane.value?.setZoom(z);
}
const statusWordCount = computed(() => footerEditor.value.wordCount);
const statusSelectionWords = computed(() => footerEditor.value.selectionWords);
const statusTrackChanges = computed(() => footerEditor.value.trackChanges);
const statusZoom = computed(() => footerEditor.value.zoom);

async function ensureNotesSession() {
  const id = session.value?.id;
  if (!id || notesSession.value || !isTauri()) return;
  notesSession.value = await openNotesSession(id);
}

function statusNotesToggleEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-test="status-notes-toggle"]');
}

function rememberStoryNotesOpener() {
  const active = document.activeElement as HTMLElement | null;
  const toggle = active?.closest?.('[data-test="status-notes-toggle"]') as HTMLElement | null;
  if (toggle) {
    storyNotesOpener = toggle;
    return;
  }
  if (active && active !== document.body) {
    storyNotesOpener = active;
    return;
  }
  storyNotesOpener = statusNotesToggleEl();
}

function restoreStoryNotesOpenerFocus() {
  const toggle = statusNotesToggleEl();
  const opener =
    storyNotesOpener && storyNotesOpener !== document.body && storyNotesOpener.isConnected
      ? storyNotesOpener
      : toggle;
  storyNotesOpener = null;
  (opener ?? toggle)?.focus?.();
}

async function toggleStoryNotes() {
  if (storyNotesOpen.value) {
    storyNotesOpen.value = false;
    storyNotesSheetHeight.value = 0;
    editorPane.value?.setScrollPaddingBottom(0);
    await nextTick();
    restoreStoryNotesOpenerFocus();
    return;
  }
  rememberStoryNotesOpener();
  try {
    await ensureNotesSession();
    if (notesSession.value) storyNotesOpen.value = true;
  } catch (err) {
    console.error('Could not load story notes', err);
    storyNotesOpener = null;
  }
}

function onStoryNotesSheetHeight(px: number) {
  storyNotesSheetHeight.value = px;
  editorPane.value?.setScrollPaddingBottom(px);
}

async function onStoryNotesClose() {
  storyNotesOpen.value = false;
  storyNotesSheetHeight.value = 0;
  editorPane.value?.setScrollPaddingBottom(0);
  await nextTick();
  restoreStoryNotesOpenerFocus();
}
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
  <p v-if="evidence === '34-c6'" class="ev34-c6-boot" data-test="ev34-c6-bootstrap">Loading…</p>
  <Rad34InstallEvidence v-else-if="evidence === '34-install'" class="shell" />
  <Rad310UpdateEvidence v-else-if="evidence === '310-updater'" class="shell" />
  <Rad3441PilotEvidence v-else-if="evidence === '34-41'" />
  <Rad60ReviewEvidence v-else-if="evidence === 'rad60-review'" class="shell" />
  <Rad38NotesEvidence v-else-if="evidence === '38-notes'" class="shell" />
  <Rad67EditorChromeEvidence v-else-if="evidence === 'rad67'" class="shell" />
  <Rad55FocusModeEvidence v-else-if="evidence === 'rad55'" class="shell shell--focus-mode" />
  <Rad304ChapterEvidence v-else-if="evidence === '304-chapter'" class="shell" />
  <Rad36WpEvidence v-else-if="evidence === '36-wp'" class="shell" />
  <ShellsPreview v-else-if="preview" class="shell" :initial="preview" @close="preview = null" />
  <main v-else class="shell" :class="{ 'shell--focus-mode': focusMode }">
    <div class="shell__main">
      <PairingPrompt
        v-if="info && isTauri()"
        :context-manuscript-id="session?.id ?? null"
        @approved="onPairingApproved"
      />
      <FeedbackPrompt v-if="info && isTauri()" />
      <SendFeedbackModal
        v-if="feedbackOpen && isTauri()"
        :info="info"
        :excerpt="feedbackExcerpt"
        @close="closeFeedbackModal"
      />
      <div v-show="!focusMode" class="shell__chrome" data-test="shell-chrome">
        <header class="topbar">
          <details
            ref="appMenu"
            class="topbar__menu"
            data-test="app-menu"
            @toggle="onAppMenuToggle"
          >
            <summary
              ref="bookMenuTrigger"
              class="topbar__trigger"
              data-test="app-menu-trigger"
              aria-label="Book menu"
              title="Book menu"
              aria-haspopup="menu"
            >
              <AppIcon name="menu" class="topbar__hamburger" />
              <AppLogo :size="24" />
            </summary>
          </details>
          <OverlayAnchoredMenu
            :open="bookMenuOpen"
            :trigger="bookMenuTrigger"
            placement="bottom-start"
          >
            <div class="topbar__menu-list sh-menu" role="menu" @keydown="onBookMenuKeydown">
              <button
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-new"
                :aria-disabled="importing ? 'true' : undefined"
                @click="
                  () => {
                    if (importing) return;
                    void onToolbarDraftNew();
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
                    void openDraftFromDialog();
                    closeBookMenu();
                  }
                "
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="folder" class="app-menu-icon"
                /></span>
                Open…<span class="sh-k">{{ appMenuShortcuts.open }}</span>
              </button>
              <button
                v-if="session && isTauri()"
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-save"
                @click="() => void onMenuSave()"
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="check" class="app-menu-icon"
                /></span>
                Save<span v-if="appMenuShortcuts.save" class="sh-k">{{
                  appMenuShortcuts.save
                }}</span>
              </button>
              <button
                v-if="session && isTauri()"
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-save-as"
                @click="() => void onMenuSaveAs()"
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="folder" class="app-menu-icon"
                /></span>
                Save As…<span v-if="appMenuShortcuts.saveAs" class="sh-k">{{
                  appMenuShortcuts.saveAs
                }}</span>
              </button>
              <button
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-import"
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
                  ><AppIcon name="word-doc" class="app-menu-icon"
                /></span>
                Import Word .docx<span v-if="appMenuShortcuts.importWord" class="sh-k">{{
                  appMenuShortcuts.importWord
                }}</span>
              </button>
              <button
                v-if="session && isTauri()"
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-history"
                @click="
                  () => {
                    historyOpen = true;
                    closeBookMenu();
                  }
                "
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="clock" class="app-menu-icon"
                /></span>
                History
              </button>
              <div
                class="topbar__recent"
                @mouseenter="recentOpen = true"
                @mouseleave="recentOpen = false"
              >
                <button
                  ref="recentTrigger"
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
              </div>
              <div class="sh-sep" role="separator" />
              <button
                v-if="isTauri()"
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-feedback"
                @click="
                  () => {
                    openFeedback(settingsButton);
                    closeBookMenu();
                  }
                "
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="pencil" class="app-menu-icon"
                /></span>
                Send feedback
              </button>
              <button
                v-if="session && !choosingBook && isTauri()"
                type="button"
                class="sh-mi"
                role="menuitemcheckbox"
                data-test="app-menu-story-notes"
                :aria-checked="storyNotesOpen ? 'true' : 'false'"
                @click="
                  () => {
                    void toggleStoryNotes();
                    closeBookMenu();
                  }
                "
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="sparkle" class="app-menu-icon"
                /></span>
                Story notes
              </button>
              <button
                v-if="isTauri()"
                type="button"
                class="sh-mi"
                role="menuitem"
                data-test="app-menu-check-updates"
                @click="() => void checkForUpdatesManual()"
              >
                <span class="sh-mi-lead" aria-hidden="true"
                  ><AppIcon name="refresh" class="app-menu-icon"
                /></span>
                Check for updates…
              </button>
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
          </OverlayAnchoredMenu>
          <OverlayAnchoredMenu
            :open="bookMenuOpen && recentOpen && recentBooks.length > 0"
            :trigger="recentTrigger"
            placement="right-start"
          >
            <div
              class="topbar__menu-list sh-menu topbar__recent-flyout"
              role="menu"
              aria-label="Recent books"
              @click.stop
              @keydown="onRecentMenuKeydown"
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
          </OverlayAnchoredMenu>
          <span class="topbar__brand">
            <span class="topbar__name">{{
              session && !choosingBook ? session.title : PRODUCT_NAME
            }}</span>
          </span>
        </header>
        <!-- #84 / #232: chrome row stays outside the scrolling desk; toolbar teleports here. -->
        <div
          v-if="session && !choosingBook"
          id="toolbar-row"
          class="toolbar-row"
          data-test="toolbar-row"
        >
          <div id="toolbar-slot" class="toolbar-slot" data-test="toolbar-slot"></div>
        </div>
      </div>
      <MigrationNoticeBanner :notices="migrationNotices" @dismiss="dismissMigration" />
      <SettingsScreen
        v-if="settingsOpen"
        :info="info"
        :backup-status="backupStatus"
        :confirming-restore="confirmingRestore"
        :tokens-notice="tokensNotice"
        :book-open="!!session && !choosingBook"
        :book-title="session?.title"
        :numbering-style="session?.numberingStyle.value"
        :manuscript-id="session?.id"
        @close="settingsOpen = false"
        @open-feedback="
          () => {
            openFeedback();
            settingsOpen = false;
          }
        "
        @numbering-style="onNumberingStyle"
        @open-previews="openPreview('all')"
        @backup="onBackup"
        @ask-restore="confirmingRestore = true"
        @confirm-restore="onRestore"
        @cancel-restore="confirmingRestore = false"
        @dismiss-notice="tokensNotice = null"
      />
      <AgentsWindow
        v-if="agentsOpen"
        :batch-banner="agentsBatchBanner"
        :initial-selected-agent-ids="newlyPairedAgentIds"
        :agents="agentsForWindow"
        :manuscripts="draftRows"
        :current-manuscript-id="session?.id ?? null"
        :current-draft-title="draftPickerLabel"
        @close="closeAgentsWindow"
        @open-settings="openAgentsSettingsFromWindow"
        @dismiss-batch="dismissAgentsBatch"
      />
      <p v-if="askBotRequested" class="visually-hidden" data-test="ask-bot-requested" role="status">
        Ask bot requested
      </p>
      <div v-if="recoveryNotices.length" role="alert" data-test="recovery-notice">
        <p>
          A restore was interrupted. Some attachments may be missing. {{ PRODUCT_NAME }} didn't
          delete anything.
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
        accept="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        tabindex="-1"
        aria-hidden="true"
        :disabled="importing"
        @change="onFile"
      />
      <p v-if="fatalError" role="alert" data-test="fatal-error">{{ fatalError }}</p>
      <p v-if="openError && !openingError" role="alert" data-test="open-error">{{ openError }}</p>
      <SaveFailureBanner
        v-if="saveFailure.failing"
        data-test="save-error"
        :state="saveFailure"
        :save-copy="onSaveCopyWithOffer"
        :offer-relink="saveCopyRelinkOffer"
        @relink="() => void onSaveCopyRelink()"
      />
      <HistoryPanel
        v-if="isTauri()"
        :open="historyOpen"
        :manuscript-id="session?.id ?? null"
        :menu-trigger="bookMenuTrigger"
        :before-restore="onHistoryBeforeRestore"
        @close="historyOpen = false"
        @restored="() => void reloadOpenManuscript()"
      />
      <!-- Always mounted so the live region exists before its text (#79). -->
      <Teleport to="#app-overlay-layer">
        <div
          v-if="isTauri() && updatePrompt.mode !== 'hidden'"
          class="update-toast-wrap"
          data-test="update-prompt-wrap"
        >
          <UpdatePromptToast
            :mode="updatePrompt.mode"
            :version="updatePrompt.version"
            :progress="updatePrompt.progress"
            :manual-message="updatePrompt.manualMessage"
            @update-now="() => void installUpdateNow()"
            @later="onUpdateLater"
            @dismiss="onUpdateDismissManual"
          />
        </div>
        <div
          class="open-toast"
          data-test="open-toast"
          :style="toastStyle ?? undefined"
          @mouseenter="pauseChapterToastTimer"
          @mouseleave="resumeChapterToastTimer"
          @focusin="pauseChapterToastTimer"
          @focusout="onChapterToastFocusOut"
        >
          <!-- #98: the no-room cue shares this one polite region with the open-book toast. -->
          <AppToast
            :open="(!!openToast || noRoomToast) && !!session && !chapterToast"
            :lead="noRoomToast ? undefined : 'Your book is open.'"
            :message="noRoomToast ? NO_ROOM_COPY : openToast"
            :action="noRoomToast ? 'Hide notes' : undefined"
            :icon="noRoomToast ? 'alert' : 'check'"
            @dismiss="noRoomToast ? hideNotesForOutline() : dismissToast()"
          />
          <AppToast
            data-test="chapter-action-toast"
            :open="!!chapterToast"
            :message="chapterToast?.message ?? ''"
            :detail="chapterToast?.detail"
          >
            <template #actions>
              <p
                v-if="chapterToastUndoBlocked"
                class="chapter-toast__undo-hint"
                data-test="chapter-toast-undo-hint"
              >
                {{ chapterToastUndoHint() }}
              </p>
              <button
                type="button"
                class="sh-btn"
                data-test="chapter-toast-undo"
                :disabled="chapterToastUndoBlocked"
                :aria-disabled="chapterToastUndoBlocked ? 'true' : undefined"
                @click="undoChapterAction"
              >
                Undo
              </button>
              <button
                type="button"
                class="sh-btn"
                data-test="chapter-toast-dismiss"
                @click="dismissChapterToast"
              >
                Dismiss
              </button>
            </template>
          </AppToast>
        </div>
        <MergeChapterConfirm
          v-if="mergePending"
          :target-title="mergePending.targetTitle"
          :source-title="mergePending.sourceTitle"
          :skip-ask-session="mergeSkipConfirmSession"
          @close="onMergeClose"
          @confirm="onMergeConfirm"
        />
      </Teleport>
      <HomeScreen
        v-if="showImportHome"
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
        v-if="showOpeningShell"
        class="opening-shell"
        :class="{ 'opening-shell--overlay': openingShellOverlay }"
        data-test="opening-shell"
      >
        <div role="alert" aria-live="assertive" data-test="opening-error">
          <ErrorCard
            v-if="openingErrorShown"
            autofocus
            :icon="errorCardIcon(openingErrorShown.code)"
            :tone="openingErrorShown.tone"
            :title="openingErrorShown.title"
            :text="openingErrorShown.message"
            :action="openingErrorShown.actionLabel"
            dismissible
            @action="onOpeningErrorAction"
            @dismiss="dismissOpeningError"
          />
        </div>
        <OpeningProgress
          v-if="openingVisible && opening"
          :title="opening.title"
          :found="opening.found"
          :progress="opening.progress"
          :kind="opening.kind"
          :indeterminate="opening.indeterminate"
          :cancellable="opening.kind === 'import' && importing"
          @cancel="cancelImportOpening"
        />
        <section
          v-else-if="startupResume === 'pending'"
          class="op-start"
          data-test="startup-loading"
          aria-busy="true"
        >
          <AppLogo :size="48" aria-hidden="true" />
          <p class="op-start__text">{{ openingDeck.loadingBook }}</p>
        </section>
      </div>
      <div
        v-if="session && !choosingBook"
        class="shell__desk min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden"
        data-test="shell-desk"
      >
        <div
          class="workspace grid min-h-0 min-w-0 flex-1 gap-0 overflow-hidden pt-4 pb-4 pl-4 pr-0"
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
            :change-counts="changeCounts"
            :numbering-style="session.numberingStyle.value"
            @select="selectedId = $event"
            @activate="focusEditor"
            @numbering-style="onNumberingStyle"
            @split-chapter="onOutlineSplitChapter"
            @merge-chapter="(target, source) => requestChapterMerge(target, source)"
          />
          <OutlineRail v-show="!navigatorOpen && !focusMode" @expand="outlineAuto.toggleByHand()" />
          <div class="editor-stack min-h-0 min-w-0" data-test="editor-stack">
            <ContinuousManuscript
              ref="editorPane"
              class="editor-stack__page min-h-0 min-w-0 flex-1"
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
              :manuscript-save="manuscriptSave"
              :story-notes-open="storyNotesOpen"
              story-notes-panel-id="story-notes-panel"
              :author-labels="markAuthorLabel"
              toolbar-target="#toolbar-slot"
              external-load-error
              :outline-forced="outlineForced"
              :notes-hidden="notesHidden"
              :computer-name="info?.computerName"
              :decision-records-by-section="decisionRecordsBySection"
              :manuscript-id="session.id"
              :draft-label="draftPickerLabel"
              :draft-rows="draftRows"
              :current-draft-id="session.id"
              :comment-meta-version="commentMetaVersion"
              :lead-chapter-ops="leadChapterOps"
              :split-across-thread-ids="splitAcrossThreadIds"
              @update:selected-id="selectedId = $event"
              @split-chapter="onEditorSplitChapter"
              @merge-prev-chapter="onEditorMergePrev"
              @load-error="editorLoadError = $event"
              @reload="reloadSection"
              @toggle-navigator="outlineAuto.toggleByHand()"
              @decisions="onSectionDecisions"
              @comment-reply="onCommentReply"
              @comment-resolve="onCommentResolve"
              @layout="onEditorLayout"
              @focus-mode="focusMode = $event"
              @ask-bot="onAskBotFromEditor"
              @toggle-story-notes="toggleStoryNotes"
              @save-retry="onManuscriptSaveRetry"
              @words-before-caret="onWordsBeforeCaret"
              @change-counts="changeCounts = $event"
              @reading-position="onReadingPosition"
              @open-settings="openToolbarSettings"
              @open-agents="openToolbarAgents"
              @draft-new="onToolbarDraftNew"
              @draft-import="onToolbarDraftImport"
              @draft-select="onToolbarDraftSelect"
              @draft-menu-open="onToolbarDraftMenuOpen"
            />
          </div>
        </div>
        <StoryNotesSheet
          v-if="storyNotesOpen && notesSession && !focusMode"
          :notes-doc="notesSession.doc"
          :outline="session.outline.value"
          :human-author="humanNotesAuthor"
          :readonly="session.closed || restoreInProgress"
          anchor-selector="[data-test='continuous-manuscript']"
          @select-section="focusEditor"
          @close="onStoryNotesClose"
          @sheet-height="onStoryNotesSheetHeight"
        />
      </div>
    </div>
    <StatusBar
      v-if="session && !choosingBook && !focusMode"
      class="shell__status"
      :chapter-count="chapterCount"
      :show-chapter-segment="navigatorOpen"
      :column-tracks="footerColumnTracks"
      :word-count="statusWordCount"
      :selection-words="statusSelectionWords"
      :words-before-caret-in-book="wordsBeforeCaretInBook"
      :track-changes="statusTrackChanges"
      :save="manuscriptSave"
      :story-notes-open="storyNotesOpen"
      story-notes-panel-id="story-notes-panel"
      :zoom="statusZoom"
      @toggle-story-notes="toggleStoryNotes"
      @save-retry="onManuscriptSaveRetry"
      @update:zoom="onFooterZoom"
    />
  </main>
</template>

<style>
.update-toast-wrap {
  position: fixed;
  top: var(--ct-space-12);
  right: var(--ct-space-6);
  z-index: var(--ct-z-toast);
  pointer-events: auto;
}
.open-toast {
  position: fixed;
  bottom: var(--ct-space-12);
  left: 50%;
  z-index: var(--ct-z-toast);
  transform: translateX(-50%);
  pointer-events: auto;
}
.chapter-toast__undo-hint {
  margin: 0;
  flex: 1 1 100%;
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.open-toast :deep(.toast) {
  flex-wrap: wrap;
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
.ev34-c6-boot {
  margin: var(--ct-space-8);
  color: var(--ct-text-muted);
  font-family: var(--ct-font-ui);
}
.shell {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 26px;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.shell.shell--focus-mode {
  grid-template-rows: minmax(0, 1fr);
}
.shell__main {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  overscroll-behavior: none;
}
.opening-shell--overlay {
  position: absolute;
  inset: 0;
  z-index: var(--ct-z-overlay);
  background: var(--ct-scrim);
}
.op-start {
  max-width: 560px;
  margin: 0 auto;
  padding: calc(var(--ct-space-10) + var(--ct-space-1));
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
  text-align: center;
}
.op-start__text {
  margin: var(--ct-space-4) 0 0;
  font-size: var(--ct-text-xl);
  font-weight: var(--ct-weight-semibold);
}
@media (max-width: 639px) {
  .opening-shell {
    padding: var(--ct-space-4);
  }
}
.shell__chrome {
  position: relative;
  z-index: var(--ct-z-chrome);
  flex: none;
  min-width: 0;
  background: var(--ct-surface);
}
.shell__desk {
  min-width: 0;
}
.toolbar-row {
  flex: none;
  background: var(--ct-surface);
}
.toolbar-slot {
  width: 100%;
  min-height: 2.75rem;
}
.editor-error-region .load-error {
  margin: var(--ct-space-2) var(--ct-space-4) 0;
}
.shell__desk > .workspace {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.editor-stack {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.editor-stack__page {
  flex: 1 1 auto;
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
  z-index: var(--ct-z-flyout);
  width: 240px;
  white-space: nowrap;
}
.topbar__menu-list.sh-menu.topbar__recent-flyout {
  width: 220px;
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
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
