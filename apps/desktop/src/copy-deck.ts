/**
 * Central writer-facing copy (#34). Vue/TS UI must read strings from here, not hard-code them.
 */
import { PARAGRAPH_STYLE_LABELS, type ParagraphStyle } from '@swarmdraft/editor';
import type { NumberingStyle } from '@swarmdraft/schema';
import { PRODUCT_NAME } from './lib/brand';
import type { NoteType } from './notes/doc';

export { PRODUCT_NAME };

export function appName(): string {
  return PRODUCT_NAME;
}

/** First-run and open book screens (HomeScreen). */
export const home = {
  welcomeTitle: (app = appName()) => `Welcome to ${app}`,
  welcomeLede:
    'A calm place to write and revise your book. Your writing assistant can only suggest changes — you decide what stays.',
  getStarted: 'Get started',
  welcomeNote: (app = appName()) =>
    `Your book stays on this computer. ${app} saves your work as you go.`,
  openTitle: "Let's import your book",
  openLede:
    "Choose the Word manuscript you've been working on. We'll make a working copy — your original file is never changed.",
  importButton: 'Import Word .docx',
  importingButton: 'Importing your book…',
  dropAria: 'Drop a Word manuscript here to import it',
  dropHint: 'Or drag your manuscript here from a folder',
  backToBook: 'Back to my book',
} as const;

/** ob8 empty states. */
export const emptyStates = {
  reviewTitle: 'Nothing to review',
  reviewText:
    'When your writing assistant suggests a change, it will show up here for you to keep or skip.',
  commentsTitle: 'No comments yet',
  commentsText: 'Select some text and choose Comment to leave yourself a note.',
  notesEmptyTitle: 'No story notes yet',
  notesFilterTitle: 'No notes match this filter',
  notesText: 'Capture planning notes, character reminders, or research beside your draft.',
} as const;

/** ob6 opening progress (OpeningProgress.vue). */
export const opening = {
  importHint: 'Getting your chapters ready from Word. This can take a minute for a long book.',
  openHint: 'Getting your chapters ready. This usually takes a few seconds.',
  verbImport: 'Importing',
  verbOpen: 'Opening',
  /** Shown on cold start before we know whether a last book exists (#329). */
  loadingBook: 'Opening your book…',
  progressLabel: (verb: string) => `${verb} progress`,
  chaptersFound: (count: number) => `Found ${count} chapters so far`,
  cancel: 'Cancel',
} as const;

/** In-app updater toast (#310). */
export const updater = {
  updateNow: 'Update now',
  later: 'Later',
  gotIt: 'Got it',
  downloadingMessage: 'Downloading update…',
  downloadingAria: 'Downloading update',
  manualUpToDate: "You're up to date.",
  manualOffline: "Couldn't check for updates. Check your connection and try again.",
  manualError: "Couldn't check for updates. Try again in a few minutes.",
  manualInstallFailed: "Couldn't install the update. Your work is saved — try again later.",
  availableTitle: (version: string, app = appName()) => `${app} ${version} is ready to install.`,
  availableBody: (app = appName()) => `${app} will restart. Your work is saved first.`,
} as const;

export type ManualCheckMessage = 'up-to-date' | 'offline' | 'error' | 'install-failed';

export function manualMessageCopy(message: ManualCheckMessage): string {
  switch (message) {
    case 'up-to-date':
      return updater.manualUpToDate;
    case 'offline':
      return updater.manualOffline;
    case 'error':
      return updater.manualError;
    case 'install-failed':
      return updater.manualInstallFailed;
  }
}

export function availableTitle(version: string): string {
  return updater.availableTitle(version);
}

export function availableBody(): string {
  return updater.availableBody();
}

/** Window close while saves are pending. */
export const closeFlush = {
  unsavedQuitPrompt: "Some edits aren't saved. Quit anyway?",
} as const;

export const busyNotice =
  'A backup, restore, or copy is already running. Wait for it to finish, then try again.';

export const footerSave = {
  errorLabel: "Couldn't save. Retrying…",
} as const;

export const pageEstimateTooltip = 'Estimated manuscript page (~250 words). Not print layout.';

export const sectionLoadErrorCopy = (app = appName()) =>
  `Part of this section uses formatting ${app} can't edit yet, so it's open read-only and changes won't be saved.`;

/** Error cards (issue #62 / ob9). */
export type ErrorAction = 'choose-another-file' | 'try-again' | 'save-a-copy' | 'dismiss';

export type ErrorCopyBlock = {
  title: string;
  message: string;
  action: ErrorAction;
  actionLabel: string;
  tone: 'danger' | 'warning';
};

export function errorCopyBlocks(app = appName()): Record<string, ErrorCopyBlock> {
  return {
    'not-word-file': {
      title: "This isn't a Word manuscript",
      message: `${app} can import Word manuscripts. Try choosing a different file.`,
      action: 'choose-another-file',
      actionLabel: 'Choose another file',
      tone: 'danger',
    },
    'file-damaged': {
      title: "We couldn't read this file",
      message: 'It may be damaged. If you have another copy, try opening that one.',
      action: 'choose-another-file',
      actionLabel: 'Choose another file',
      tone: 'danger',
    },
    'file-too-large': {
      title: 'This file is too big to open',
      message: 'Try saving the manuscript without large pictures, then open it again.',
      action: 'choose-another-file',
      actionLabel: 'Choose another file',
      tone: 'warning',
    },
    'file-locked': {
      title: 'This book is open in another program',
      message: 'Close it in the other program, then try again.',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
    'disk-full': {
      title: 'Your computer is almost full',
      message: "There isn't enough room to save your book. Free up some space, then try again.",
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
    'no-permission': {
      title: `${app} isn't allowed to use this file`,
      message: 'Try a file in your Documents folder, or save a copy somewhere else.',
      action: 'choose-another-file',
      actionLabel: 'Choose another file',
      tone: 'warning',
    },
    'not-found': {
      title: "We couldn't find that file",
      message: 'It may have been moved or deleted. Try opening it again.',
      action: 'choose-another-file',
      actionLabel: 'Choose another file',
      tone: 'warning',
    },
    'save-failed': {
      title: "Your latest changes aren't saved yet",
      message: `Don't close ${app}. We'll keep trying, or save a copy somewhere else now.`,
      action: 'save-a-copy',
      actionLabel: 'Save a copy',
      tone: 'danger',
    },
    'save-relink-book': {
      title: 'Copy saved',
      message: `Save your book to the same folder to keep working there and clear this warning.`,
      action: 'save-a-copy',
      actionLabel: 'Save book here',
      tone: 'warning',
    },
    'export-failed': {
      title: "We couldn't make your book file",
      message: 'Your manuscript is safe. Try again, and if it keeps happening, try another format.',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'danger',
    },
    'word-export-unavailable': {
      title: "Word export isn't ready",
      message: "Word export isn't available on this computer yet.",
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
    'pandoc-offline': {
      title: "Couldn't set up Word export",
      message:
        'Word export needs a one-time download. Connect to the internet and try again, or choose an existing program in Export settings.',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
    'pandoc-checksum': {
      title: "Word export setup didn't verify",
      message:
        'The download may have been interrupted. Try again, or choose an existing program in Export settings.',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
    unknown: {
      title: 'Something went wrong',
      message: 'Your writing is safe. Try again in a moment.',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    },
  };
}

/** Export menus and settings (#39, toolbar #245). */
export const exportCopy = {
  desktopOnly: 'Export is only available in the desktop app.',
  pdfLater: 'PDF export is coming in a later update.',
  markdownLater: 'Markdown export is coming in a later update.',
  couldNotOpenFolder: 'Could not open that folder.',
  exportLabel: 'Export',
  exportManuscriptTitle: 'Export manuscript',
  exportFormatsAria: 'Export formats',
  wordManuscript: 'Word manuscript',
  pdfLabel: 'PDF',
  comingLater: 'Coming later',
  markdownLabel: 'Markdown',
  openSavedFolder: 'Show in folder',
  sectionTitle: 'Export',
  sectionIntro:
    'Build a reader-ready EPUB or Word file from the accepted manuscript text (suggestions and comments are not included). Choose where to save the file when export finishes.',
  openBookToExport: 'Open a book to export it.',
  thisBook: 'This book',
  pdfPrintLater: 'PDF print export is coming in a later update.',
  exportEpub: 'Export EPUB',
  exportWord: 'Export for Word',
  exportFormatEpub: 'EPUB',
  exportFormatWord: 'Word',
  wordExportHeading: 'Word export on this computer',
  wordExportIntro: (app = appName()) =>
    `On first export, ${app} sets up Word export automatically. To use a program already on this computer, pick it here.`,
  wordExportPathLabel: 'Program path (optional)',
  wordExportPlaceholder: 'Leave blank for automatic setup',
  browse: 'Browse…',
  chooseWordExportProgram: 'Choose program',
  preparingWordExport: 'Preparing Word export…',
  downloadingWordExport: 'Downloading Word export…',
  installingWordExport: 'Installing Word export…',
  exportStarted: 'Export started…',
  exportStillWorking: 'Still working… check again in a moment.',
  exportCancelled: 'Export cancelled.',
  recentHeading: 'Recent exports',
  noRecent: 'No exports yet for this book.',
  openFolder: 'Open folder',
} as const;

/** Agent pairing dialog (#188). */
export const pairing = {
  dialogTitleSingle: (name: string) => `Allow ${name} to connect?`,
  dialogTitleBulk: (count: number) => `Allow ${count} bots to connect?`,
  accessSuggest: 'Suggest changes',
  accessComment: 'Comment',
  accessRead: 'Read',
  nameCollision: (name: string) =>
    `A bot named ${name} already exists. Choose another name or revoke the existing agent in Settings › Agents.`,
  dialogBody:
    'Bots on this computer are asking to connect. Each gets a key with the access shown. You can revoke keys later in Settings › Agents.',
  dialogHint: 'Esc denies all pending requests. Focus returns to the app when the queue is empty.',
  deny: 'Deny',
  allow: 'Allow',
  denyAll: 'Deny all',
  allowAll: 'Allow all',
} as const;

/** Settings › Agents connection row (#188). */
export const agentConnection = {
  notConnected: 'Not connected',
  connected: 'Connected',
  lastActiveMin: (min: number) => `Last active ${min} min ago`,
  lastActiveHours: (hours: number) => `Last active ${hours} h ago`,
  lastActiveDays: (days: number) => `Last active ${days} d ago`,
} as const;

/** Settings › Agents page (#99, #187, #192). */
export const agentsSettings = {
  pageTitle: 'Agents',
  lede: 'Agents are helpers that work on your book through a key you give them. They can read, comment and suggest — accepting or rejecting suggestions is always up to you.',
  newKeyForPrefix: 'New key for',
  tokenDescBold: "Copy this key now. This key won't be shown again.",
  tokenDescRest: "Paste it into the agent's setup.",
  newAgentKeyAria: 'New agent key',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: "Couldn't copy automatically. The key is selected above; press Ctrl+C to copy it.",
  done: 'Done',
  addAgentHeading: 'Add an agent',
  agentNameAria: 'Agent name',
  agentColorAria: 'Agent color',
  addAgentButton: 'Add agent',
  newKeysCanLegend: 'New keys can',
  scopeHint: {
    read: 'see your books',
    comment: 'leave comments',
    suggest: 'propose edits',
  },
  yourAgentsHeading: 'Your agents',
  noAgentsYet: 'No agents yet.',
  newKeyButton: 'New key',
  removeAgent: 'Remove agent',
  lastUsedNever: 'never',
  tokenMetaMid: ' · last used ',
  turnedOff: 'Turned off',
  turnOffKey: 'Turn off key',
  removedAgentsToggle: (count: number) => `Removed agents (${count})`,
  removedHelp:
    'Removed agents stay listed only while they still have suggestions or comments in your books. Name and color stay so old marks keep their attribution.',
  removedFallback: 'Removed',
} as const;

/** User-facing "Removed Oct 30" from an ISO revoked_at timestamp (#192). */
export function formatAgentRemovedDate(revokedAt: string | null): string {
  if (!revokedAt) return agentsSettings.removedFallback;
  const ms = Date.parse(revokedAt);
  if (Number.isNaN(ms)) return agentsSettings.removedFallback;
  const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
  return `${agentsSettings.removedFallback} ${label}`;
}

export const profileSave = {
  genericError: "Couldn't save your name and color on this computer. Try again.",
} as const;

export const reviewCopy = {
  outdatedExplanation: 'This suggestion no longer applies after another change was accepted.',
} as const;

export const numberingStyleLabels: Record<NumberingStyle, string> = {
  chapter_arabic: 'Chapter 1',
  chapter_words: 'Chapter One',
  chapter_upper: 'ONE',
  number_only: '1 only',
};

export const noteTypeLabels: Record<NoteType, string> = {
  character: 'Character',
  place: 'Place',
  plot: 'Plot',
  research: 'Research',
  other: 'Other',
};

export type ToolbarStyle = 'body' | 'heading' | 'scene_break' | 'block_quote';
export type CaretStyle = ToolbarStyle | Exclude<ParagraphStyle, 'body' | 'block_quote'> | '';

export const styleLabels: Record<Exclude<CaretStyle, ''>, string> = {
  body: 'Body',
  heading: 'Heading',
  scene_break: 'Scene break',
  block_quote: 'Block quote',
  first: PARAGRAPH_STYLE_LABELS.first,
  epigraph: PARAGRAPH_STYLE_LABELS.epigraph,
  verse: PARAGRAPH_STYLE_LABELS.verse,
  centered: PARAGRAPH_STYLE_LABELS.centered,
};

/** Keyboard shortcut sheet row labels (#56). Chords stay in toolbar/review modules. */
export const shortcutSheet = {
  formatting: 'Formatting',
  editing: 'Editing',
  review: 'Review',
  view: 'View',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  heading: 'Heading',
  blockQuote: 'Block quote',
  bodyText: 'Body text',
  undo: 'Undo',
  redo: 'Redo',
  find: 'Find',
  replace: 'Replace',
  addComment: 'Add comment',
  nextChange: 'Next change',
  previousChange: 'Previous change',
  acceptChange: 'Accept change',
  rejectChange: 'Reject change',
  shortcutsSheet: 'Keyboard shortcuts',
  focusMode: 'Focus mode',
  exitFocusMode: 'Exit focus mode',
  toggleSidebars: 'Toggle sidebars',
  escClosePrefix: 'Press ',
  escKeyLabel: 'Esc',
  escCloseSuffix: ' to close',
  closeAriaLabel: 'Close keyboard shortcuts',
  windowsConventionsLead: 'Windows conventions. Press ',
  macConventionsLead: 'Mac conventions. Press ',
  windowsConventionsTrail: ' any time to open this sheet.',
  sheetTitle: 'Keyboard shortcuts',
} as const;

/** App shell strings used in App.vue and chrome. */
export const appShell = {
  reopenFailed: (app = appName()) => `Couldn't reopen the manuscript. Please restart ${app}.`,
  restoreInterrupted: 'A restore was interrupted. Some attachments may be missing.',
  restoreInterruptedSuffix: (app = appName()) =>
    `${app} couldn't finish and will try again the next time it starts.`,
  noticeNotSaved: (app = appName()) =>
    `This notice couldn't be saved and won't show again after you close ${app}.`,
  bookMenu: 'Book menu',
} as const;

/** Settings › General › About labels (technical; avoid banned jargon). */
export const settingsAbout = {
  dataVersion: 'Data version',
} as const;
