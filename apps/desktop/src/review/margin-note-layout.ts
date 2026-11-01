/** Vertical stacking for margin suggestion callouts (#212). */

export const MARGIN_NOTE_GAP_PX = 8;
export const MARGIN_CONNECTOR_FADE_PX = 24;
export const MARGIN_IDEAL_TOLERANCE_PX = 8;

export interface MarginNoteMeasure {
  key: string;
  idealTop: number;
  height: number;
}

export interface MarginNoteLayout {
  key: string;
  top: number;
  idealTop: number;
  nudged: boolean;
}

/** Stack margin cards with min gap; the selected key keeps its ideal top and reflows neighbors. */
export function stackMarginNoteTops(
  items: readonly MarginNoteMeasure[],
  selectedKey: string | null,
): MarginNoteLayout[] {
  if (!items.length) return [];
  const gap = MARGIN_NOTE_GAP_PX;
  const tops = items.map((it) => it.idealTop);

  for (let i = 1; i < items.length; i++) {
    tops[i] = Math.max(items[i]!.idealTop, tops[i - 1]! + items[i - 1]!.height + gap);
  }

  if (selectedKey) {
    const si = items.findIndex((it) => it.key === selectedKey);
    if (si >= 0) {
      tops[si] = items[si]!.idealTop;
      for (let i = si + 1; i < items.length; i++) {
        tops[i] = Math.max(items[i]!.idealTop, tops[i - 1]! + items[i - 1]!.height + gap);
      }
      for (let i = si - 1; i >= 0; i--) {
        tops[i] = Math.min(tops[i]!, tops[i + 1]! - items[i]!.height - gap);
      }
    }
  }

  return items.map((it, i) => ({
    key: it.key,
    top: tops[i]!,
    idealTop: it.idealTop,
    nudged: Math.abs(tops[i]! - it.idealTop) > MARGIN_CONNECTOR_FADE_PX,
  }));
}

/** Keep the selected card visible inside the margin column when ideal top is off-screen. */
export function clampSelectedMarginTop(
  layouts: readonly MarginNoteLayout[],
  selectedKey: string | null,
  heights: Readonly<Record<string, number>>,
  viewportHeight: number,
): MarginNoteLayout[] {
  if (!selectedKey || viewportHeight <= 0) return [...layouts];
  const si = layouts.findIndex((l) => l.key === selectedKey);
  if (si < 0) return [...layouts];
  const height = heights[selectedKey] ?? 48;
  const maxTop = Math.max(0, viewportHeight - height);
  return layouts.map((l, i) => {
    if (i !== si) return { ...l };
    const top = Math.min(Math.max(l.idealTop, 0), maxTop);
    return {
      ...l,
      top,
      nudged: Math.abs(top - l.idealTop) > MARGIN_CONNECTOR_FADE_PX,
    };
  });
}
