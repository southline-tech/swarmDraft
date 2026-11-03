export type AnchorPlacement = 'bottom-start' | 'bottom-end' | 'right-start';

const GAP = 4;
const MARGIN = 8;

/** Fixed viewport position for a floating menu anchored to a trigger rect. */
export function anchorMenuPosition(
  trigger: DOMRect,
  menu: DOMRect,
  placement: AnchorPlacement,
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = 0;
  let left = 0;

  if (placement === 'bottom-start') {
    top = trigger.bottom + GAP;
    left = trigger.left;
  } else if (placement === 'bottom-end') {
    top = trigger.bottom + GAP;
    left = trigger.right - menu.width;
  } else {
    top = trigger.top;
    left = trigger.right + GAP;
    if (left + menu.width > vw - MARGIN) {
      left = trigger.left - menu.width - GAP;
    }
  }

  left = Math.max(MARGIN, Math.min(left, vw - menu.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - menu.height - MARGIN));
  return { top, left };
}
