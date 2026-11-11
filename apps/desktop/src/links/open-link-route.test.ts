import { describe, expect, it, vi, type Mock } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { ChangeLinkRoute } from './open-link';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));

const links = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({
    action: 'unknown' as const,
    manuscriptId: 'book-1',
  })) as Mock<
    (manuscriptId: string, changeId: string) => Promise<{ action: 'unknown'; manuscriptId: string }>
  >,
  take: vi.fn(async (): Promise<string | null> => null),
  listen: vi.fn(async () => () => {}) as Mock<
    (onUrl: (url: string) => void) => Promise<() => void>
  >,
}));

vi.mock('../backend', () => ({
  linksResolve: (manuscriptId: string, changeId: string) => links.resolve(manuscriptId, changeId),
  linksTakeLaunchUrl: () => links.take(),
  listenChangeLinks: (onUrl: (url: string) => void) => links.listen(onUrl),
}));

import { startChangeLinkRoute } from './open-link';

function route(): ChangeLinkRoute & { opened: ReturnType<typeof vi.fn> } {
  const opened = vi.fn(async () => true);
  return {
    opened,
    ensureManuscript: opened,
    focusChange: vi.fn(async () => {}),
    showHistory: vi.fn(),
    showToast: vi.fn(),
    resetLinkUi: vi.fn(),
    showSelectedChanges: vi.fn(),
    clearOpenError: vi.fn(),
    onFailure: vi.fn(),
  };
}

describe('change link route (#117)', () => {
  it('subscribes before taking the cold-start url, and opens a repeated url once', async () => {
    const order: string[] = [];
    const url = 'swarmdraft://open?draft=book-1&change=chg-1';
    links.listen.mockImplementation(async (onUrl) => {
      order.push('listen');
      onUrl(url);
      return () => {};
    });
    links.take.mockImplementation(async () => {
      order.push('take');
      return url;
    });
    const r = route();
    const stop = startChangeLinkRoute(r);
    await flushPromises();
    expect(order).toEqual(['listen', 'take']);
    expect(r.opened).toHaveBeenCalledTimes(1);
    stop();
  });
});
