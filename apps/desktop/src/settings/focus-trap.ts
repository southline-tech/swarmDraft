/** Keeps Tab and Shift+Tab inside `root` (modal dialogs and the full-window Settings screen). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.closest('[hidden], [inert]')) return false;
    // Content of a closed <details> can't take focus; its <summary> can.
    const d = el.closest('details');
    return !d || d.open || el.parentElement === d;
  });
}

export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const items = focusables(root).filter((el) => !isHiddenByStyle(el, root));
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/** v-show sections use display:none; skip anything inside one. */
function isHiddenByStyle(el: HTMLElement, root: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) {
    if (n.style.display === 'none') return true;
  }
  return false;
}
