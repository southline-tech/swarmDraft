import { ref, watch, type Ref } from 'vue';

/**
 * Page column sizes (#92). They mirror `--ct-page-min-w`, `--ct-page-gutter` and
 * `--ct-margin-notes-w` in tokens.css (a test keeps them in step).
 */
export const PAGE_MIN_W = 440;
export const PAGE_GUTTER = 24;
export const MARGIN_NOTES_W = 104;
/** #97: gap kept between the notes column and the review panel (--ct-space-4). */
export const MARGIN_NOTES_GAP = 16;
/** Desk room the notes take beside the page: column plus its gap (--ct-page-notes-room). */
export const NOTES_ROOM = MARGIN_NOTES_W + MARGIN_NOTES_GAP;
/** Page floor while the writer forces the outline open (#96); mirrors `--ct-page-forced-min-w`. */
export const PAGE_FORCED_MIN_W = 320;

/**
 * #96: with the outline forced open the page may drop below 440px; then its inner side padding
 * shrinks to --ct-space-8. True when the page column (desk minus gutters and notes) is under 440px.
 */
export function forcedPageNarrow(
  forced: boolean,
  deskWidth: number,
  marginNotes: boolean,
): boolean {
  return forced && deskWidth > 0 && deskWidth < deskNeeded(marginNotes);
}

/** Desk width the page needs to stay at or above its 440px minimum, gutters (and notes) included. */
export function deskNeeded(marginNotes: boolean): number {
  return PAGE_MIN_W + 2 * PAGE_GUTTER + (marginNotes ? NOTES_ROOM : 0);
}

/** What the editor reports about its layout: whether the review panel shows, and the desk's room. */
export interface EditorLayout {
  reviewShown: boolean;
  deskWidth: number;
  marginNotes: boolean;
  /** Desk's left edge in the window (px); used to keep overlays like the toast on the desk. */
  deskLeft?: number;
  /** Focus mode is on (#97): layout changes then say nothing about the writer's outline choice. */
  focusMode?: boolean;
}

/** #97: desk width a forced-open outline still leaves room for (320px page, gutters, notes). */
export function forcedDeskNeeded(marginNotes: boolean): number {
  return PAGE_FORCED_MIN_W + 2 * PAGE_GUTTER + (marginNotes ? NOTES_ROOM : 0);
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
  /** #97: the writer's forced-open outline was closed because page + notes could not fit. */
  const forcedClosed = ref(false);
  /** Desk width (outline open) when `forcedClosed` was set; reopen once that would fit. */
  let forcedClosedDesk = 0;

  function update(next: EditorLayout) {
    // #97: focus mode hides the panels; keep every flag so the writer's outline comes back as it was.
    if (next.focusMode) return;
    const wasShown = layout.value?.reviewShown ?? false;
    layout.value = next;
    if (!next.reviewShown) {
      if (wasShown || autoClosed.value) {
        if ((autoClosed.value && !manual.value) || forcedClosed.value) navigatorOpen.value = true;
        autoClosed.value = false;
        forcedClosed.value = false;
        manual.value = false;
      }
      return;
    }
    if (manual.value) {
      if (forcedClosed.value) {
        // Space came back (e.g. the notes hid): give the writer their outline again.
        if (forcedClosedDesk >= forcedDeskNeeded(next.marginNotes)) {
          forcedClosed.value = false;
          navigatorOpen.value = true;
        }
      } else if (
        navigatorOpen.value &&
        next.deskWidth > 0 &&
        next.deskWidth < forcedDeskNeeded(next.marginNotes)
      ) {
        // #97: even a forced outline yields when the page and notes can't fit: never clip a note.
        forcedClosedDesk = next.deskWidth;
        forcedClosed.value = true;
        navigatorOpen.value = false;
      }
      return;
    }
    if (!navigatorOpen.value) return;
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
    forcedClosed.value = false;
    // Only a choice made while the review panel shows overrides auto-collapse (#93 review).
    if (layout.value?.reviewShown) manual.value = true;
  }

  // The writer toggled while no review panel shows: nothing pending to restore.
  watch(navigatorOpen, () => {
    if (!layout.value?.reviewShown) autoClosed.value = false;
  });

  return { update, toggleByHand, autoClosed, manual, forcedClosed };
}
