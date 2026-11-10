import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ContextMenu from '../shells/ContextMenu.vue';
import type { ContextMenuAction } from '../shells/context-menu';
import OldChangeView from './OldChangeView.vue';

describe('change link menu and backdrop (#117, #123)', () => {
  it('the menu item receives the click and the scrim click closes without the card', async () => {
    const menu = mount(ContextMenu, {
      props: { x: 8, y: 8 },
      attachTo: document.body,
    });
    const copy = menu.get('[data-test="ctx-copy_link"]');
    const comment = menu.get('[data-test="ctx-comment"]');
    expect(
      copy.element.compareDocumentPosition(comment.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await copy.trigger('click');
    expect(menu.emitted('select')?.[0]).toEqual(['copy_link']);
    menu.unmount();

    const disabled = mount(ContextMenu, {
      props: {
        x: 8,
        y: 8,
        disabled: new Set<ContextMenuAction>(['copy_link']),
        copyLinkTitle: 'Right-click a suggested change to copy a link to it.',
      },
      attachTo: document.body,
    });
    const item = disabled.get('[data-test="ctx-copy_link"]');
    expect(item.attributes('aria-disabled')).toBe('true');
    expect(item.attributes('aria-describedby')).toBe('ctx-reason-copy_link');
    expect(item.find('.sh-mi-reason').text()).toBe(
      'Right-click a suggested change to copy a link to it.',
    );
    await item.trigger('click');
    expect(disabled.emitted('select')).toBeUndefined();
    disabled.unmount();

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
    expect(scrim.classList.contains('st-dlg-scrim')).toBe(true);
    expect(scrim.classList.contains('sh-scrim')).toBe(false);
    expect(scrim.classList.contains('scrim')).toBe(false);
    expect(card.classList.contains('st-dlg')).toBe(true);
    expect(card.classList.contains('card')).toBe(false);
    expect(card.classList.contains('dlg')).toBe(false);
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
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../shells/shells.css'),
      'utf8',
    );
    expect(source).not.toMatch(/z-index/);
    expect(source).not.toMatch(/<style/);
    expect(css).toMatch(/\.old-change\s*\{/);
    expect(css).toMatch(/\.old-change__actions\s*\{/);
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
    expect(document.activeElement?.getAttribute('data-test')).toBe('old-change-back');
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
