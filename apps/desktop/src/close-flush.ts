/**
 * Save pending section edits before the desktop window closes. Tauri's close-requested event is
 * intercepted, the flush is awaited (bounded by a timeout so a stuck save can't keep the window
 * open), then the window is destroyed. If edits are still unsaved, the user is asked whether to
 * quit anyway; on No the window stays open. `pagehide` stays as a best-effort fallback (browser
 * or a reload, where there is no close-requested event).
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const CLOSE_FLUSH_TIMEOUT_MS = 3000;
export const UNSAVED_QUIT_PROMPT = "Some edits aren't saved. Quit anyway?";

/** 'saved', or 'unsaved' if the flush failed or didn't finish within `ms`; never rejects. */
export function flushWithTimeout(
  flush: () => Promise<void>,
  ms: number,
): Promise<'saved' | 'unsaved'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('unsaved'), ms);
    flush().then(
      () => {
        clearTimeout(t);
        resolve('saved');
      },
      () => {
        clearTimeout(t);
        resolve('unsaved');
      },
    );
  });
}

/** Ask with the native dialog when available, else `window.confirm`. */
export async function confirmQuit(message = UNSAVED_QUIT_PROMPT): Promise<boolean> {
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return await ask(message, { title: 'coAuthor', kind: 'warning' });
  } catch {
    return window.confirm(message);
  }
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
      try {
        if ((await flushWithTimeout(flush, timeoutMs)) !== 'saved' && !(await confirmQuit())) {
          closing = false; // stay open; the next close request asks again
          return;
        }
        await win.destroy();
      } catch {
        // destroy failed: allow another close request, and try the plain web close meanwhile.
        closing = false;
        try {
          window.close();
        } catch {
          /* nothing else to try; the user can close again */
        }
      }
    });
  }
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    unlisten();
  };
}
