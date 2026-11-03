/** True when the event target is a review-card composer control (#264). */
export function isReviewComposerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-test="reply-input"]')) return true;
  if (target.closest('.comment-actions')) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') {
    return target.closest('[data-review-row-key]') !== null;
  }
  return target.isContentEditable && target.closest('[data-review-row-key]') !== null;
}

export function reviewComposerHasFocus(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && isReviewComposerTarget(el);
}
