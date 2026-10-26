/**
 * Save pending section edits before the desktop window closes. Tauri's close-requested event is
 * intercepted, the flush is awaited (bounded by a timeout so a stuck save can't keep the window
 * open), then the window is destroyed. `pagehide` stays as a best-effort fallback (browser or a
 * reload, where there is no close-requested event).
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const CLOSE_FLUSH_TIMEOUT_MS = 3000;

/** Resolve after `flush` settles or `ms` pass, whichever is first; never rejects. */
export function flushWithTimeout(flush: () => Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    flush()
      .catch(() => {})
      .finally(() => {
        clearTimeout(t);
        resolve();
      });
  });
}

/** Install the handlers; returns a function that removes them. */
export async function flushOnClose(
  flush: () => Promise<void>,
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
): Promise<() => void> {
  const onPageHide = () => void flush().catch(() => {});
  window.addEventListener('pagehide', onPageHide);
  let unlisten = () => {};
  if (isTauri()) {
    const win = getCurrentWindow();
    let closing = false;
    unlisten = await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      await flushWithTimeout(flush, timeoutMs);
      await win.destroy();
    });
  }
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    unlisten();
  };
}
