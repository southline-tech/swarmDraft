import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HistoryPanel from './HistoryPanel.vue';

vi.mock('../backend', () => ({
  draftHistory: vi.fn(async () => [
    {
      oid: 'abc123',
      timeUnix: 1_700_000_000,
      committerName: 'Ada',
      message: 'Saved the chapter',
    },
  ]),
  draftRestore: vi.fn(async () => 'abc123'),
}));

describe('History panel', () => {
  it('keeps teleported layout rules in shells.css', () => {
    const vue = readFileSync(resolve(__dirname, 'HistoryPanel.vue'), 'utf8');
    const css = readFileSync(resolve(__dirname, '../shells/shells.css'), 'utf8');
    expect(vue).not.toMatch(/<style/);
    expect(css).toMatch(/\.history-panel\s*\{/);
    expect(css).toMatch(/\.history-panel__list\s*\{/);
    expect(css).toMatch(/\.history-panel__confirm-actions\s*\{/);
  });

  it('lists saved versions and asks before restore', async () => {
    const w = mount(HistoryPanel, {
      props: { open: false, manuscriptId: 'm1' },
      attachTo: document.body,
    });
    await w.setProps({ open: true });
    await flushPromises();
    await flushPromises();
    const panel = document.body.querySelector('[data-test="history-panel"]');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toContain('Saved the chapter');
    expect(panel?.textContent).toContain('Ada');
    const restore = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Restore'),
    );
    expect(restore).toBeTruthy();
    restore?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-test="history-restore-confirm"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Restore this version?');
    w.unmount();
  });
});
