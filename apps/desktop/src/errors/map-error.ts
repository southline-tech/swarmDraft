/**
 * Plain-language error mapping (issue #62, mockup ob9).
 *
 * Every error that can reach the UI (Rust command strings such as `io: ...` / `sqlite: ...` /
 * `not found: ...`, OS error codes, .docx import errors, export errors, plain JS errors) goes
 * through `mapError`, which returns a stable code and copy that is safe to show. Raw error text
 * is never part of the result; keep it for logs via `rawErrorText`.
 */

import { errorCopyBlocks, sectionLoadErrorCopy as sectionLoadErrorCopyFn } from '../copy-deck';
import { PRODUCT_NAME } from '../lib/brand';

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
  | 'pandoc-offline'
  | 'pandoc-checksum'
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

const COPY = errorCopyBlocks(PRODUCT_NAME) as Record<ErrorCode, Omit<MappedError, 'code'>>;

/** Best-effort raw text of any thrown value, for logs only. Never show this to the user. */
export function rawErrorText(err: unknown): string {
  const safe = (f: () => unknown): string | undefined => {
    try {
      const v = f();
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  let hasMessage = false;
  try {
    hasMessage = typeof err === 'object' && err !== null && 'message' in err;
  } catch {
    hasMessage = false;
  }
  if (hasMessage) {
    const m = safe(() => String((err as { message: unknown }).message));
    if (m !== undefined) return m;
  }
  return safe(() => JSON.stringify(err)) ?? safe(() => String(err)) ?? '';
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
  ['pandoc-offline', /pandoc: offline:/i],
  ['pandoc-checksum', /pandoc: checksum:/i],
  [
    'export-failed',
    /pandoc is not available|pandoc is not installed|pandoc: extract:|pandoc: override:|pdf export is not in this build|export failed/i,
  ],
];

export function mapError(err: unknown, context: ErrorContext = 'other'): MappedError {
  const text = rawErrorText(err);
  let isUnsaved = false;
  try {
    isUnsaved = err instanceof Error && err.name === 'UnsavedEditsError';
  } catch {
    // A hostile getter must never make mapError throw.
  }
  // A flush that left edits unsaved is always a save problem, whatever the caller was doing.
  if (isUnsaved) context = 'save';
  let code: ErrorCode | undefined = RULES.find(([, re]) => re.test(text))?.[0];
  if (!code) {
    if (context === 'save') code = 'save-failed';
    else if (context === 'export') code = 'export-failed';
    else if (context === 'import' || context === 'open') code = 'file-damaged';
    else code = 'unknown';
  }
  return { code, ...COPY[code] };
}

/** State for the save-failure banner (`SaveFailureBanner.vue`). */
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

/** One line of safe copy for an inline alert: the mapped title and message, never raw text. */
export function errorLine(err: unknown, context: ErrorContext = 'other'): string {
  const m = mapError(err, context);
  return `${m.title}. ${m.message}`;
}

/**
 * Writer copy for a section whose content the editor can't load (#89). The parser's own
 * message (e.g. `Unknown node type: ...`) goes to the console only, never into this line.
 */
export const SECTION_LOAD_ERROR_COPY = sectionLoadErrorCopyFn(PRODUCT_NAME);
