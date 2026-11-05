import type { OpeningProgressEvent } from '../backend';
import type { ErrorCode } from './map-error';

/** Wait this long before showing ob6 so fast opens never flash (#80). */
export const OPENING_REVEAL_MS = 120;

export interface OpeningUiState {
  title: string;
  found: number;
  /** 0–1 for the progress bar; ignored when `indeterminate`. */
  progress: number;
  /** Stored-book open vs Word import (#299 / #301). */
  kind: 'open' | 'import';
  /** Word import has no granular progress yet (#299). */
  indeterminate?: boolean;
}

export function openingStateFromEvent(
  prev: OpeningUiState | null,
  event: OpeningProgressEvent,
): OpeningUiState {
  return {
    title: event.title || prev?.title || '',
    found: event.chaptersFound,
    progress: Math.min(1, Math.max(0, event.percent / 100)),
    kind: prev?.kind ?? 'open',
    indeterminate: false,
  };
}

export function openingUiForImport(title: string): OpeningUiState {
  return { title, found: 0, progress: 0, kind: 'import', indeterminate: true };
}

export function openingUiForStoredOpen(title: string): OpeningUiState {
  return { title, found: 0, progress: 0, kind: 'open', indeterminate: false };
}

export function errorCardIcon(code: ErrorCode): 'alert' | 'lock' | 'disk' | 'save' {
  if (code === 'file-locked') return 'lock';
  if (code === 'disk-full') return 'disk';
  if (code === 'save-failed') return 'save';
  return 'alert';
}

export function titleFromDocxName(fileName: string): string {
  const base = fileName.replace(/\.docx$/i, '').trim();
  return base || fileName;
}

/** Opening label once the importer has resolved a manuscript title (#215). */
export function openingTitleAfterImport(manuscriptTitle: string, fileName: string): string {
  const t = manuscriptTitle.trim();
  if (t && t !== 'Untitled') return t;
  return titleFromDocxName(fileName);
}

/** Stored import bytes for opening-error "Try again" (#80). */
export type OpeningRetry =
  | { kind: 'reopen-latest'; title: string }
  | { kind: 'open-manuscript'; id: string; title: string }
  | { kind: 'create-blank'; title: string }
  | { kind: 'import'; name: string; bytes: Uint8Array };
