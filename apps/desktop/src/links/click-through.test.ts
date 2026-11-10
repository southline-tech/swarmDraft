import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ContextMenu from '../shells/ContextMenu.vue';
import OldChangeView from './OldChangeView.vue';

describe('change link menu and backdrop (#117, #123)', () => {
  it('the menu item receives the click and the scrim click closes without the card', async () => {
    const menu = mount(ContextMenu, {
      props: { x: 8, y: 8, showCopyLink: true },
      attachTo: document.body,
    });
    await menu.get('[data-test="ctx-copy_link"]').trigger('click');
    expect(menu.emitted('select')?.[0]).toEqual(['copy_link']);
    menu.unmount();

    const view = mount(OldChangeView, {
      props: {
        view: {
          manuscriptId: 'book-1',
          changeId: 'chg-1',
          sectionId: 'sec-1',
          quote: 'guttered',
          kind: 'suggestion_insert',
          authorName: 'Ada',
          outcome: 'accepted',
          decidedBy: 'Sam',
          decidedAt: 1700000000,
        },
      },
      attachTo: document.body,
    });
    await flushPromises();
    const scrim = document.querySelector<HTMLElement>('[data-test="old-change-scrim"]')!;
    const card = document.querySelector<HTMLElement>('[data-test="old-change-view"]')!;
    expect(scrim.classList.contains('sh-scrim')).toBe(true);
    expect(scrim.classList.contains('scrim')).toBe(true);
    expect(card.classList.contains('st-dlg')).toBe(true);
    expect(card.classList.contains('card')).toBe(true);
    expect(card.classList.contains('dlg')).toBe(true);
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(view.emitted('close')).toBeUndefined();
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(view.emitted('close')).toHaveLength(1);
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'OldChangeView.vue'),
      'utf8',
    );
    expect(source).not.toMatch(/z-index/);
    view.unmount();
  });

  it('Escape closes the old-change view and returns focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = mount(OldChangeView, {
      props: {
        view: {
          manuscriptId: 'book-1',
          changeId: 'chg-1',
          sectionId: 'sec-1',
          quote: 'guttered',
          kind: 'suggestion_insert',
          authorName: 'Ada',
          outcome: 'rejected',
          decidedBy: 'Riley',
          decidedAt: 1700000000,
        },
      },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('old-change-close');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushPromises();
    expect(view.emitted('close')).toHaveLength(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
