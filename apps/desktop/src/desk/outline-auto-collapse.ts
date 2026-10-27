import { ref, watch, type Ref } from 'vue';

/**
 * Page column sizes (#92). They mirror `--ct-page-min-w`, `--ct-page-gutter` and
 * `--ct-margin-notes-w` in tokens.css (a test keeps them in step).
 */
export const PAGE_MIN_W = 440;
export const PAGE_GUTTER = 24;
export const MARGIN_NOTES_W = 104;

/** Desk width the page needs to stay at or above its 440px minimum, gutters (and notes) included. */
export function deskNeeded(marginNotes: boolean): number {
  return PAGE_MIN_W + 2 * PAGE_GUTTER + (marginNotes ? MARGIN_NOTES_W : 0);
}

/** What the editor reports about its layout: whether the review panel shows, and the desk's room. */
export interface EditorLayout {
  reviewShown: boolean;
  deskWidth: number;
  marginNotes: boolean;
  /** Desk's left edge in the window (px); used to keep overlays like the toast on the desk. */
  deskLeft?: number;
}

/**
 * Where the open-book toast sits (#93): centred on the desk and no wider than it, so it never
 * covers the review panel or outline. Null until the desk has been measured (falls back to CSS).
 */
export function toastPlacement(l: EditorLayout | null): { left: string; maxWidth: string } | null {
  if (!l || l.deskWidth <= 0 || l.deskLeft === undefined) return null;
  return {
    left: `${l.deskLeft + l.deskWidth / 2}px`,
    maxWidth: `${Math.max(0, l.deskWidth - 2 * PAGE_GUTTER)}px`,
  };
}

/**
 * Auto-collapse of the outline (#92). While the review panel shows and the page would drop below
 * its minimum, the outline closes; it reopens when the review panel closes. Once the writer opens
 * or closes the outline by hand, that choice wins: no auto close or reopen until the review panel
 * closes again.
 */
export function useOutlineAutoCollapse(navigatorOpen: Ref<boolean>) {
  /** The outline is closed because of this rule (not by the writer). */
  const autoClosed = ref(false);
  /** The writer toggled the outline by hand since the review panel opened. */
  const manual = ref(false);
  const layout = ref<EditorLayout | null>(null);

  function update(next: EditorLayout) {
    const wasShown = layout.value?.reviewShown ?? false;
    layout.value = next;
    if (!next.reviewShown) {
      if (wasShown || autoClosed.value) {
        if (autoClosed.value && !manual.value) navigatorOpen.value = true;
        autoClosed.value = false;
        manual.value = false;
      }
      return;
    }
    if (manual.value || !navigatorOpen.value) return;
    // deskWidth 0 means "not laid out yet" (hidden, or no layout engine): never act on it.
    if (next.deskWidth > 0 && next.deskWidth < deskNeeded(next.marginNotes)) {
      navigatorOpen.value = false;
      autoClosed.value = true;
    }
  }

  /** The writer's own toggle (toolbar Chapters button). */
  function toggleByHand() {
    navigatorOpen.value = !navigatorOpen.value;
    autoClosed.value = false;
    manual.value = true;
  }

  // The writer toggled while no review panel shows: nothing pending to restore.
  watch(navigatorOpen, () => {
    if (!layout.value?.reviewShown) autoClosed.value = false;
  });

  return { update, toggleByHand, autoClosed, manual };
}
