import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: { preventDefault: () => void }) => Promise<void>;
const win = vi.hoisted(() => ({
  handler: undefined as undefined | ((e: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
  unlisten: vi.fn(),
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

import { flushOnClose } from './close-flush';

afterEach(() => {
  vi.useRealTimers();
  win.destroy.mockClear();
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
    stop();
    expect(win.unlisten).toHaveBeenCalled();
  });

  it('closes anyway after the timeout if the flush hangs or fails', async () => {
    vi.useFakeTimers();
    await flushOnClose(() => new Promise<void>(() => {}), 1000);
    const closing = win.handler!({ preventDefault: () => {} });
    await vi.advanceTimersByTimeAsync(999);
    expect(win.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(win.destroy).toHaveBeenCalledTimes(1);

    await flushOnClose(() => Promise.reject(new Error('locked')), 1000);
    await win.handler!({ preventDefault: () => {} });
    expect(win.destroy).toHaveBeenCalledTimes(2);
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
