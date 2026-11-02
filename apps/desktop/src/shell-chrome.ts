/** Top edge of shell chrome in viewport coordinates (for tests and guards). */
export function shellChromeViewportTop(): number {
  return document.querySelector('[data-test="shell-chrome"]')?.getBoundingClientRect().top ?? 0;
}

/**
 * Section navigation must not scroll the document (#261). WebKit may still apply a
 * document scroll when focusing the editor; reset so topbar + toolbar stay visible.
 */
export function restoreWindowScroll(): void {
  if (typeof window === 'undefined') return;
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}
