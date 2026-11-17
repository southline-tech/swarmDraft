import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: { preventDefault: () => void }) => Promise<void>;
const win = vi.hoisted(() => ({
  handler: undefined as undefined | ((e: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
  unlisten: vi.fn(),
  ask: vi.fn<(message: string, opts?: unknown) => Promise<boolean>>(async () => false),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: Handler) => {
      win.handler = h;
      return win.unlisten;
    },
    destroy: win.destroy,
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: win.ask }));

import {
  CLOSE_FLUSH_LONG_MS,
  flushOnClose,
  flushWithTimeout,
  UNSAVED_QUIT_PROMPT,
} from './close-flush';

const requestClose = () => win.handler!({ preventDefault: () => {} });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  win.destroy.mockReset();
  win.ask.mockReset();
  win.handler = undefined;
});

describe('flushOnClose', () => {
  it('keeps the window open until pending edits are flushed, then closes it', async () => {
    const order: string[] = [];
    let finish = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = () => {
            order.push('flushed');
            r();
          };
        }),
    );
    win.destroy.mockImplementation(async () => void order.push('destroyed'));
    const stop = await flushOnClose(flush);
    const preventDefault = vi.fn();
    const closing = win.handler!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(win.destroy).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(order).toEqual(['flushed', 'destroyed']);
    expect(win.ask).not.toHaveBeenCalled();
    stop();
    expect(win.unlisten).toHaveBeenCalled();
  });

  it('asks before quitting with unsaved edits; No keeps the window open, Yes quits', async () => {
    await flushOnClose(() => Promise.reject(new Error('locked')));
    win.ask.mockResolvedValueOnce(false);
    await requestClose();
    expect(win.ask).toHaveBeenCalledWith(UNSAVED_QUIT_PROMPT, expect.anything());
    expect(win.destroy).not.toHaveBeenCalled();
    // The flag was reset: a second close request asks again.
    win.ask.mockResolvedValueOnce(true);
    await requestClose();
    expect(win.ask).toHaveBeenCalledTimes(2);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it('treats a flush that times out as unsaved and asks', async () => {
    vi.useFakeTimers();
    await flushOnClose(() => new Promise<void>(() => {}), 1000, { longMs: 1000 });
    win.ask.mockResolvedValueOnce(true);
    const closing = requestClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(win.ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(win.ask).toHaveBeenCalledTimes(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to window.confirm when the native dialog is unavailable', async () => {
    await flushOnClose(() => Promise.reject(new Error('locked')));
    win.ask.mockRejectedValueOnce(new Error('dialog plugin missing'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await requestClose();
    expect(confirm).toHaveBeenCalledWith(UNSAVED_QUIT_PROMPT);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('if destroy fails, falls back to window.close and allows another close request', async () => {
    await flushOnClose(async () => {});
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    win.destroy.mockRejectedValueOnce(new Error('not allowed'));
    await requestClose();
    expect(close).toHaveBeenCalledTimes(1);
    await requestClose();
    expect(win.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not ask when the flush finishes after the short timeout', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let done!: () => void;
    const flushing = flushOnClose(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
      3000,
    );
    await flushing;
    const closing = requestClose();
    await vi.advanceTimersByTimeAsync(3500);
    done();
    await vi.runAllTimersAsync();
    await closing;
    expect(win.ask).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^close flush saved in \d+ms$/));
  });

  it('flushes on pagehide as a fallback', async () => {
    const flush = vi.fn(async () => {});
    const stop = await flushOnClose(flush);
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('flushWithTimeout', () => {
  it('resolves saved after the short timeout when the flush eventually succeeds', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let done!: () => void;
    const result = flushWithTimeout(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
      { shortMs: 3000, longMs: CLOSE_FLUSH_LONG_MS },
    );
    await vi.advanceTimersByTimeAsync(3500);
    done();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('saved');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^close flush saved in \d+ms$/));
  });

  it('resolves unsaved when the flush rejects', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(flushWithTimeout(() => Promise.reject(new Error('locked')))).resolves.toBe(
      'unsaved',
    );
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^close flush unsaved in \d+ms$/));
  });
});
