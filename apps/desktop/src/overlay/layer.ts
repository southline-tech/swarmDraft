/** Shared overlay mount for floating UI (menus, modals, toasts). */
export const APP_OVERLAY_LAYER = '#app-overlay-layer';

/** Create or return the global overlay root (survives test body resets). */
export function ensureOverlayLayer(): HTMLElement {
  let el = document.getElementById('app-overlay-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-overlay-layer';
    el.dataset.test = 'app-overlay-layer';
    el.className = 'app-overlay-layer';
    document.body.appendChild(el);
  }
  return el;
}
