/** Stable id for the expanded review panel region (#67 a11y). */
export const REVIEW_CHANGES_REGION_ID = 'review-changes-region';

/** Move focus among radiogroup options with arrow keys (#177). */
export function roveViewRadio(e: KeyboardEvent, root: HTMLElement): void {
  if (
    e.key !== 'ArrowDown' &&
    e.key !== 'ArrowUp' &&
    e.key !== 'ArrowLeft' &&
    e.key !== 'ArrowRight'
  )
    return;
  const options = [...root.querySelectorAll<HTMLElement>('[data-view-option]')];
  if (!options.length) return;
  const i = options.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
  options[(i + dir + options.length) % options.length]!.focus();
}
