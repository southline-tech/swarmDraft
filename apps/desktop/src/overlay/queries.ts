/** Query teleported UI in the global overlay layer (tests + helpers). */
import { DOMWrapper } from '@vue/test-utils';
import { ensureOverlayLayer } from './layer';

export function queryInOverlay<T extends Element = HTMLElement>(selector: string): T | null {
  const layer = ensureOverlayLayer();
  return layer.querySelector<T>(selector);
}

export function queryAllInOverlay<T extends Element = HTMLElement>(selector: string): T[] {
  const layer = ensureOverlayLayer();
  return [...layer.querySelectorAll<T>(selector)];
}

export function overlayWrap(selector: string): DOMWrapper<Element> {
  const el = queryInOverlay(selector);
  if (!el) throw new Error(`Missing overlay node: ${selector}`);
  return new DOMWrapper(el);
}

export function overlayVisible(selector: string): boolean {
  const el = queryInOverlay(selector);
  if (!el) return false;
  return el.checkVisibility?.() ?? true;
}
