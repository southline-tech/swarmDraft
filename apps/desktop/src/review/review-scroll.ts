import { parseBookChangeKey, scopeBookChangeKey, BOOK_SCOPE } from './review-book';

const MARK_SELECTOR =
  'ins[data-suggestion][data-id], del[data-suggestion][data-id], span[data-format-change][data-id]';

export interface ManuscriptMarkAnchor {
  scopedKey: string;
  top: number;
  el: Element;
}

function changeKeyFromMark(el: Element): string | null {
  const id = el.getAttribute('data-id');
  const author = el.getAttribute('data-author');
  if (!id || !author) return null;
  return `${author}\u0000${id}`;
}

/** Collect open suggestion marks in reading order within the continuous scroller. */
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
 * Applies hysteresis before switching to a neighbor.
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
  let candidate = anchors[0]!.scopedKey;
  for (const a of anchors) {
    if (a.top >= line) {
      candidate = a.scopedKey;
      break;
    }
    candidate = a.scopedKey;
  }
  if (!previousKey || previousKey === candidate) return candidate;
  const prev = anchors.find((a) => a.scopedKey === previousKey);
  const next = anchors.find((a) => a.scopedKey === candidate);
  if (prev && next && Math.abs(prev.top - next.top) < hysteresis) return previousKey;
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

export function findMarkElement(root: HTMLElement, scopedKey: string): Element | null {
  const parsed = parseBookChangeKey(scopedKey);
  if (!parsed) return null;
  const section = root.querySelector(`[data-section-anchor="${CSS.escape(parsed.sectionId)}"]`);
  if (!section) return null;
  const [author, id] = parsed.changeKey.split('\u0000');
  if (!author || !id) return null;
  for (const mark of section.querySelectorAll(MARK_SELECTOR)) {
    if (mark.getAttribute('data-author') === author && mark.getAttribute('data-id') === id) {
      return mark;
    }
  }
  return null;
}

/** Instant list scroll: row top at scrollTop = offsetTop - padding. */
export function scrollListRowToTop(list: HTMLElement, row: HTMLElement, padding = 8): void {
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const delta = rowRect.top - listRect.top - padding;
  list.scrollTop += delta;
}

export { BOOK_SCOPE, parseBookChangeKey };
