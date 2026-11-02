import { describe, expect, it, vi } from 'vitest';
import { restoreWindowScroll, shellChromeViewportTop } from './shell-chrome';

describe('shell-chrome (#261)', () => {
  it('restoreWindowScroll resets document scrollY', () => {
    vi.stubGlobal('scrollTo', vi.fn());
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 42 });
    restoreWindowScroll();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    vi.unstubAllGlobals();
  });

  it('shellChromeViewportTop reads shell chrome rect', () => {
    const el = document.createElement('div');
    el.dataset.test = 'shell-chrome';
    el.getBoundingClientRect = () =>
      ({ top: 12, bottom: 100, left: 0, right: 800, width: 800, height: 88 }) as DOMRect;
    document.body.appendChild(el);
    expect(shellChromeViewportTop()).toBe(12);
    el.remove();
  });
});
