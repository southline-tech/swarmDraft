import { parseBookChangeKey, scopeBookChangeKey, BOOK_SCOPE } from './review-book';

const MARK_SELECTOR =
  'ins[data-suggestion][data-id], del[data-suggestion][data-id], span[data-format-change][data-id], span.comment-anchor[data-id]';

import { COMMENT_REVIEW_PREFIX, commentReviewKey } from './review-inline';

export { commentReviewKey };

export interface ManuscriptMarkAnchor {
  scopedKey: string;
  top: number;
  el: Element;
}

function changeKeyFromMark(el: Element): string | null {
  if (el.classList.contains('comment-anchor')) {
    const id = el.getAttribute('data-id');
    return id ? commentReviewKey(id) : null;
  }
  const id = el.getAttribute('data-id');
  const author = el.getAttribute('data-author');
  if (!id || !author) return null;
  return `${author}\u0000${id}`;
}

/** Collect open suggestion and comment marks in reading order within the continuous scroller. */
export function collectManuscriptMarkAnchors(root: HTMLElement): ManuscriptMarkAnchor[] {
  const out: ManuscriptMarkAnchor[] = [];
  const sections = root.querySelectorAll('[data-section-anchor]');
  sections.forEach((sectionEl) => {
    const sectionId = sectionEl.getAttribute('data-section-anchor');
    if (!sectionId) return;
    sectionEl.querySelectorAll(MARK_SELECTOR).forEach((mark) => {
      const changeKey = changeKeyFromMark(mark);
      if (!changeKey) return;
      const rect = mark.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) return;
      out.push({
        scopedKey: scopeBookChangeKey(sectionId, changeKey),
        top: rect.top,
        el: mark,
      });
    });
  });
  out.sort((a, b) => a.top - b.top || a.scopedKey.localeCompare(b.scopedKey));
  return out;
}

/**
 * Active mark per Designer (#217): first mark with top >= viewportTop + lineOffset, else last above.
 * Neighbor switches require the new mark to cross the decision line by `hysteresis` px.
 */
export function pickActiveManuscriptMark(
  anchors: readonly ManuscriptMarkAnchor[],
  root: HTMLElement,
  previousKey: string | null,
  lineOffset = 64,
  hysteresis = 8,
): string | null {
  if (!anchors.length) return null;
  const line = root.getBoundingClientRect().top + lineOffset;
  const atOrBelow = anchors.filter((a) => a.top >= line);
  let candidate: string;
  if (atOrBelow.length) {
    candidate = atOrBelow[0]!.scopedKey;
  } else {
    const aboveLine = anchors.filter((a) => a.top < line);
    candidate = aboveLine.length
      ? aboveLine[aboveLine.length - 1]!.scopedKey
      : anchors[0]!.scopedKey;
  }
  const candidateIdx = anchors.findIndex((a) => a.scopedKey === candidate);
  if (!previousKey || previousKey === candidate) return candidate;
  const prevIdx = anchors.findIndex((a) => a.scopedKey === previousKey);
  if (prevIdx < 0 || Math.abs(prevIdx - candidateIdx) !== 1) return candidate;
  const t = anchors[candidateIdx]!.top;
  if (t < line) {
    if (t > line - hysteresis) return previousKey;
  } else if (t < line + hysteresis) {
    return previousKey;
  }
  return candidate;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/** Align a section anchor with the top of the continuous scroller; never scroll the window (#261). */
export function scrollSectionAnchorToTop(root: HTMLElement, sectionEl: Element, padding = 0): void {
  const rootRect = root.getBoundingClientRect();
  const elRect = sectionEl.getBoundingClientRect();
  const delta = elRect.top - rootRect.top - padding;
  if (Math.abs(delta) < 1) return;
  root.scrollTop += delta;
}

/** Vertically center an element inside a scroll container (manuscript column). */
export function scrollElementCenterInRoot(
  root: HTMLElement,
  el: Element,
  behavior: ScrollBehavior = scrollBehavior(),
): void {
  const rootRect = root.getBoundingClientRect();
  const markRect = el.getBoundingClientRect();
  const markCenter = markRect.top + markRect.height / 2;
  const viewportCenter = rootRect.top + rootRect.height / 2;
  const delta = markCenter - viewportCenter;
  if (Math.abs(delta) < 1) return;
  root.scrollBy({ top: delta, behavior });
}

type RectEdges = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

function rectsOverlap(a: RectEdges, b: RectEdges): boolean {
  return (
    a.bottom > b.top + 1 && a.top < b.bottom - 1 && a.right > b.left + 1 && a.left < b.right - 1
  );
}

/**
 * Move `el` into a vertical band of `root` that is not covered by `obstacle`
 * (the find-breaks card). A line already beside the card stays put. Scroll is
 * clamped so a short manuscript cannot jump past its ends.
 */
export function scrollElementBesideObstacle(
  root: HTMLElement,
  el: Element,
  obstacle: DOMRect,
  padding = 8,
): void {
  const rootRect = root.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  if (!rectsOverlap(elRect, obstacle)) return;

  const coverTop = Math.max(obstacle.top, rootRect.top);
  const coverBottom = Math.min(obstacle.bottom, rootRect.bottom);
  const above = coverTop - rootRect.top;
  const below = rootRect.bottom - coverBottom;
  const aboveTarget = coverTop - padding - elRect.height;
  const belowTarget = coverBottom + padding;
  const targets = above >= below ? [aboveTarget, belowTarget] : [belowTarget, aboveTarget];
  const max = Math.max(0, root.scrollHeight - root.clientHeight);

  for (const targetTop of targets) {
    const next = Math.min(max, Math.max(0, root.scrollTop + (elRect.top - targetTop)));
    const newTop = elRect.top - (next - root.scrollTop);
    const moved = {
      top: newTop,
      bottom: newTop + elRect.height,
      left: elRect.left,
      right: elRect.right,
    };
    if (!rectsOverlap(moved, obstacle)) {
      if (next !== root.scrollTop) root.scrollTop = next;
      return;
    }
  }

  const fallback = Math.min(max, Math.max(0, root.scrollTop + (elRect.top - targets[0]!)));
  if (fallback !== root.scrollTop) root.scrollTop = fallback;
}

export function findMarkElement(root: HTMLElement, scopedKey: string): Element | null {
  const parsed = parseBookChangeKey(scopedKey);
  if (!parsed) return null;
  const section = root.querySelector(`[data-section-anchor="${CSS.escape(parsed.sectionId)}"]`);
  if (!section) return null;
  if (parsed.changeKey.startsWith(COMMENT_REVIEW_PREFIX)) {
    const id = parsed.changeKey.slice(COMMENT_REVIEW_PREFIX.length);
    return section.querySelector(`span.comment-anchor[data-id="${CSS.escape(id)}"]`);
  }
  const sep = parsed.changeKey.indexOf('\u0000');
  const author = sep > 0 ? parsed.changeKey.slice(0, sep) : '';
  const id = sep > 0 ? parsed.changeKey.slice(sep + 1) : parsed.changeKey;
  if (!id) return null;
  for (const mark of section.querySelectorAll(MARK_SELECTOR)) {
    if (mark.classList.contains('comment-anchor')) continue;
    if (
      author &&
      mark.getAttribute('data-author') === author &&
      mark.getAttribute('data-id') === id
    ) {
      return mark;
    }
  }
  for (const mark of section.querySelectorAll(MARK_SELECTOR)) {
    if (mark.classList.contains('comment-anchor')) continue;
    if (mark.getAttribute('data-id') === id) return mark;
  }
  return null;
}

function stickyHeadHeightForRow(row: HTMLElement): number {
  const group = row.closest('.chapter-group');
  const head = group?.querySelector('.chapter-head');
  return head?.getBoundingClientRect().height ?? 0;
}

/** Instant list scroll: row top below sticky chapter head + padding. */
export function scrollListRowToTop(list: HTMLElement, row: HTMLElement, padding = 8): void {
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const sticky = stickyHeadHeightForRow(row);
  const delta = rowRect.top - listRect.top - padding - sticky;
  list.scrollTop += delta;
}

export { BOOK_SCOPE, parseBookChangeKey };
