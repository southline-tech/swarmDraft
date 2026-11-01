/**
 * Page zoom (RAD-255). The page sheet keeps a fixed height at 100% zoom; zoom scales the sheet and
 * never reflows the text. Levels run 50%-200%; the chosen level persists per user (this device profile).
 */
export const ZOOM_LEVELS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200] as const;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_DEFAULT = 100;
export const ZOOM_STORAGE_KEY = 'swarmdraft.editor.zoom';
const LEGACY_ZOOM_STORAGE_KEY = 'coauthor.editor.zoom';

/** Page sheet at 100% zoom: 864px tall, 72px side padding; text measure capped at 70ch (#105). */
export const PAGE = { height: 864, margin: 72, measureCh: 70 } as const;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));
}

/** Next level above (dir 1) or below (dir -1) `z`, staying at the ends. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const c = clampZoom(z);
  if (dir > 0) return ZOOM_LEVELS.find((l) => l > c) ?? ZOOM_MAX;
  return [...ZOOM_LEVELS].reverse().find((l) => l < c) ?? ZOOM_MIN;
}

export function loadZoom(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): number {
  try {
    const v = storage?.getItem(ZOOM_STORAGE_KEY) ?? storage?.getItem(LEGACY_ZOOM_STORAGE_KEY);
    return v == null || v.trim() === '' ? ZOOM_DEFAULT : clampZoom(Number(v));
  } catch {
    return ZOOM_DEFAULT;
  }
}

export function saveZoom(
  z: number,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(ZOOM_STORAGE_KEY, String(clampZoom(z)));
  } catch {
    // Storage unavailable (private mode, quota): zoom still works for this session.
  }
}
