/**
 * Save pending section edits before the desktop window closes. Tauri's close-requested event is
 * intercepted, the flush is awaited (bounded by a long timeout so a stuck save can't keep the
 * window open forever), then the window is destroyed. A short timeout only shows a non-blocking
 * "Saving…" state; the user is asked whether to quit anyway only when the flush fails or the long
 * timeout elapses. `pagehide` stays as a best-effort fallback (browser or a reload, where there is
 * no close-requested event).
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { closeFlush as closeFlushCopy, PRODUCT_NAME } from './copy-deck';

export const CLOSE_FLUSH_TIMEOUT_MS = 3000;
export const CLOSE_FLUSH_LONG_MS = 30_000;
export const UNSAVED_QUIT_PROMPT = closeFlushCopy.unsavedQuitPrompt;

export type FlushCloseResult = 'saved' | 'unsaved';

export type FlushWithTimeoutOptions = {
  shortMs?: number;
  longMs?: number;
  onSlow?: () => void;
};

/** 'saved', or 'unsaved' if the flush failed or didn't finish within the long limit; never rejects. */
export function flushWithTimeout(
  flush: () => Promise<void>,
  options: number | FlushWithTimeoutOptions = CLOSE_FLUSH_TIMEOUT_MS,
): Promise<FlushCloseResult> {
  const shortMs =
    typeof options === 'number' ? options : (options.shortMs ?? CLOSE_FLUSH_TIMEOUT_MS);
  const longMs = typeof options === 'number' ? options : (options.longMs ?? CLOSE_FLUSH_LONG_MS);
  const onSlow = typeof options === 'number' ? undefined : options.onSlow;
  const started = Date.now();

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: FlushCloseResult) => {
      if (done) return;
      done = true;
      clearTimeout(shortTimer);
      clearTimeout(longTimer);
      console.info(`close flush ${result} in ${Date.now() - started}ms`);
      resolve(result);
    };

    const shortTimer = setTimeout(() => onSlow?.(), shortMs);
    const longTimer = setTimeout(() => finish('unsaved'), longMs);

    flush().then(
      () => finish('saved'),
      () => finish('unsaved'),
    );
  });
}

/** Ask with the native dialog when available, else `window.confirm`. */
export async function confirmQuit(message = UNSAVED_QUIT_PROMPT): Promise<boolean> {
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return await ask(message, { title: PRODUCT_NAME, kind: 'warning' });
  } catch {
    return window.confirm(message);
  }
}

export type FlushOnCloseOptions = Pick<FlushWithTimeoutOptions, 'longMs' | 'onSlow'>;

/** Install the handlers; returns a function that removes them. */
export async function flushOnClose(
  flush: () => Promise<void>,
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
  options: FlushOnCloseOptions = {},
): Promise<() => void> {
  const onPageHide = () => void flush().catch(() => {});
  window.addEventListener('pagehide', onPageHide);
  let unlisten = () => {};
  const flushOpts: FlushWithTimeoutOptions = {
    shortMs: timeoutMs,
    longMs: options.longMs,
    onSlow: options.onSlow,
  };
  if (isTauri()) {
    const win = getCurrentWindow();
    let closing = false;
    unlisten = await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if ((await flushWithTimeout(flush, flushOpts)) !== 'saved' && !(await confirmQuit())) {
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
