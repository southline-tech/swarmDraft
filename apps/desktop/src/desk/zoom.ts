/**
 * Page zoom (RAD-255). The page is a fixed 6x9 in trim at 96 px/in, so zoom scales it and never
 * reflows the text. Levels run 50%-200%; the chosen level persists per user (this device profile).
 */
export const ZOOM_LEVELS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200] as const;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_DEFAULT = 100;
export const ZOOM_STORAGE_KEY = 'coauthor.editor.zoom';

/** 6 x 9 in at 96 px/in, 0.75 in margins: a 432 px text block. */
export const PAGE = { width: 576, height: 864, margin: 72 } as const;

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
    const v = storage?.getItem(ZOOM_STORAGE_KEY);
    return v == null ? ZOOM_DEFAULT : clampZoom(Number(v));
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
