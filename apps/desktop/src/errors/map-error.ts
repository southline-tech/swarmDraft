/**
 * Plain-language error mapping (issue #62, mockup ob9).
 *
 * Every error that can reach the UI (Rust command strings such as `io: ...` / `sqlite: ...` /
 * `not found: ...`, OS error codes, .docx import errors, export errors, plain JS errors) goes
 * through `mapError`, which returns a stable code and copy that is safe to show. Raw error text
 * is never part of the result; keep it for logs via `rawErrorText`.
 */

export type ErrorCode =
  | 'not-word-file'
  | 'file-damaged'
  | 'file-too-large'
  | 'file-locked'
  | 'disk-full'
  | 'no-permission'
  | 'not-found'
  | 'save-failed'
  | 'export-failed'
  | 'unknown';

/** What the single button on the error card does. The UI decides how to perform it. */
export type ErrorAction = 'choose-another-file' | 'try-again' | 'save-a-copy' | 'dismiss';

export interface MappedError {
  code: ErrorCode;
  title: string;
  message: string;
  action: ErrorAction;
  /** Button label for `action`. */
  actionLabel: string;
  /** Icon tone for the card: danger or warning (maps to --ct-danger / --ct-warning). */
  tone: 'danger' | 'warning';
}

/** Where the error happened; changes the fallback when the cause is not recognised. */
export type ErrorContext = 'open' | 'import' | 'save' | 'export' | 'other';

const COPY: Record<ErrorCode, Omit<MappedError, 'code'>> = {
  'not-word-file': {
    title: "This isn't a Word manuscript",
    message: 'coAuthor can open books saved from Word. Try choosing a different file.',
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
    title: "coAuthor isn't allowed to use this file",
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
    message: "Don't close coAuthor. We'll keep trying, or save a copy somewhere else now.",
    action: 'save-a-copy',
    actionLabel: 'Save a copy',
    tone: 'danger',
  },
  'export-failed': {
    title: "We couldn't make your book file",
    message: 'Your manuscript is safe. Try again, and if it keeps happening, try another format.',
    action: 'try-again',
    actionLabel: 'Try again',
    tone: 'danger',
  },
  unknown: {
    title: 'Something went wrong',
    message: 'Your writing is safe. Try again in a moment.',
    action: 'try-again',
    actionLabel: 'Try again',
    tone: 'warning',
  },
};

/** Best-effort raw text of any thrown value, for logs only. Never show this to the user. */
export function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

// Order matters: specific causes before the generic ones.
const RULES: [ErrorCode, RegExp][] = [
  // Disk full: Windows os error 112 / 39, POSIX ENOSPC, SQLite SQLITE_FULL.
  [
    'disk-full',
    /os error (112|39)\b|ENOSPC|no space left|disk (is )?full|database or disk is full/i,
  ],
  // Locked: Windows sharing / lock violation (32, 33), SQLite busy/locked, EBUSY.
  [
    'file-locked',
    /os error (32|33)\b|being used by another process|EBUSY|database is locked|database table is locked|SQLITE_BUSY/i,
  ],
  [
    'no-permission',
    /os error 5\b|access is denied|permission denied|EACCES|EPERM|readonly database/i,
  ],
  ['file-too-large', /too large/i],
  ['not-word-file', /not a word document|not a valid \.docx|zip directory not found/i],
  [
    'file-damaged',
    /corrupt|truncated|checksum mismatch|unsupported zip|has no body|has no root element|DOCTYPE|malformed|database disk image is malformed|file is not a database/i,
  ],
  ['not-found', /^not found:|os error (2|3)\b|ENOENT|cannot find the (file|path)|no such file/i],
];

export function mapError(err: unknown, context: ErrorContext = 'other'): MappedError {
  const text = rawErrorText(err);
  // A flush that left edits unsaved is always a save problem, whatever the caller was doing.
  if (err instanceof Error && err.name === 'UnsavedEditsError') context = 'save';
  let code: ErrorCode | undefined = RULES.find(([, re]) => re.test(text))?.[0];
  if (!code) {
    if (context === 'save') code = 'save-failed';
    else if (context === 'export') code = 'export-failed';
    else if (context === 'import' || context === 'open') code = 'file-damaged';
    else code = 'unknown';
  }
  return { code, ...COPY[code] };
}

/** State for the save-failure banner (Implementor 1 renders it). */
export interface SaveFailureState {
  /** True while the latest edits are not on disk. */
  failing: boolean;
  /** Copy for the banner; always the save-failed card, with the cause in `cause`. */
  error: MappedError | null;
  /** Recognised cause (e.g. disk-full, file-locked), or null when unknown. */
  cause: ErrorCode | null;
  /** Consecutive failed save attempts since the last success. */
  attempts: number;
  /** When the first failure in this run happened (ms since epoch). */
  since: number | null;
}

export const SAVE_OK: SaveFailureState = {
  failing: false,
  error: null,
  cause: null,
  attempts: 0,
  since: null,
};

/** Fold one failed save attempt into the banner state. */
export function saveFailed(
  prev: SaveFailureState,
  err: unknown,
  now: number = Date.now(),
): SaveFailureState {
  const mapped = mapError(err, 'save');
  const cause = mapped.code === 'save-failed' ? null : mapped.code;
  return {
    failing: true,
    error: { ...COPY['save-failed'], code: 'save-failed' },
    cause,
    attempts: prev.attempts + 1,
    since: prev.since ?? now,
  };
}

/** A save went through: clear the banner. */
export function saveSucceeded(): SaveFailureState {
  return { ...SAVE_OK };
}
