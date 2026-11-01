/** Stable id for the expanded review panel region (#67 a11y). */
export const REVIEW_CHANGES_REGION_ID = 'review-changes-region';

/** Tab index for menu radios: only the checked option is in the tab order (#177). */
export function viewMenuTabIndex(checked: boolean): 0 | -1 {
  return checked ? 0 : -1;
}

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
  const next = options[(i + dir + options.length) % options.length]!;
  for (const o of options) o.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

/** Focus the checked menu option when the dropdown opens. */
export function focusCheckedViewOption(root: HTMLElement): void {
  const options = [...root.querySelectorAll<HTMLElement>('[data-view-option]')];
  const checked =
    options.find((o) => o.getAttribute('aria-checked') === 'true') ??
    options.find((o) => o.tabIndex === 0) ??
    options[0];
  if (!checked) return;
  for (const o of options) o.tabIndex = -1;
  checked.tabIndex = 0;
  checked.focus();
}
