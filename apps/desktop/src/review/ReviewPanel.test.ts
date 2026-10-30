import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import type { SuggestionItem } from '@coauthor/editor';
import ReviewPanel from './ReviewPanel.vue';
import { resetCollabSlots } from '../author-colors';

const items: SuggestionItem[] = [
  { id: 's1', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'flickered' },
  { id: 's2', kind: 'suggestion_delete', author: 'brett', ts: 't', text: 'glowed' },
  { id: 's3', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'fell' },
];
const key = (i: SuggestionItem) => `${i.author}\u0000${i.id}`;
const NAMES: Record<string, string> = { 'agent:a': 'Writing assistant', brett: 'Mara' };
const labels = (a: string) => ({ name: NAMES[a] ?? a, agent: a.startsWith('agent:') });

describe('ReviewPanel (RAD-258)', () => {
  beforeEach(resetCollabSlots);
  it('lists changes with the counter in the header and emits step-through actions', async () => {
    const w = mount(ReviewPanel, { props: { items, labels, currentKey: key(items[1]!) } });
    expect(w.find('h2').text()).toBe('Review changes');
    expect(w.findAll('[data-test=item]')).toHaveLength(3);
    expect(w.find('.head [data-test=counter]').text()).toBe('2 of 3');
    expect(w.findAll('[data-test=item]')[1]!.classes()).toContain('current');
    expect(w.find('[data-test=accept-current]').exists()).toBe(false);
    await w.find('[data-test=next]').trigger('click');
    await w.find('[data-test=prev]').trigger('click');
    await w.findAll('[data-test=item]')[2]!.find('[data-test=reject]').trigger('click');
    expect(w.emitted('next')).toHaveLength(1);
    expect(w.emitted('prev')).toHaveLength(1);
    expect(w.emitted('decide-one')).toEqual([[key(items[2]!), 'reject']]);
    expect(w.find('[data-test=next]').attributes('title')).toContain('Alt+Shift+Right');
    const card = w.findAll('[data-test=item]')[0]!;
    expect(card.find('[data-test=accept]').classes()).toContain('primary');
    expect(card.find('[data-test=reject]').classes()).toContain('secondary');
    expect(card.find('[data-test=accept]').attributes('title')).toContain('Ctrl+Shift+Enter');
    expect(card.find('.who').text()).toContain('Writing assistant');
    expect(card.find('.pill').text()).toBe('Bot');
    expect(w.findAll('[data-test=item]')[1]!.find('.pill').text()).toBe('Person');
  });

  it('shows a replacement as one card with an inline diff that decides both parts', async () => {
    const repl: SuggestionItem[] = [
      { id: 'r1', kind: 'suggestion_delete', author: 'agent:a', ts: 't', text: 'flickered' },
      { id: 'r1', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'guttered' },
    ];
    const w = mount(ReviewPanel, { props: { items: repl } });
    const cards = w.findAll('[data-test=item]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.find('[data-test=del]').text()).toBe('flickered');
    expect(cards[0]!.find('[data-test=ins]').text()).toBe('guttered');
    await cards[0]!.find('[data-test=accept]').trigger('click');
    expect(w.emitted('decide-one')).toEqual([[key(repl[0]!), 'accept']]);
  });

  it('moves focus and selects filter options with arrow keys and Space', async () => {
    const w = mount(ReviewPanel, { props: { items, labels }, attachTo: document.body });
    await w.find('[data-test=filter-toggle]').trigger('click');
    await w.vm.$nextTick();
    expect(document.activeElement).toBe(w.find('[data-test=filter-all]').element);
    const menu = w.find('[data-test=filter-menu]');
    const opts = w.findAll('[data-test=filter-option]');
    (w.find('[data-test=filter-all]').element as HTMLElement).focus();
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(opts[0]!.element);
    await menu.trigger('keydown', { key: ' ' });
    expect(w.emitted('show-only')).toEqual([['agent:a']]);

    await w.find('[data-test=filter-toggle]').trigger('click');
    const optsAgain = w.findAll('[data-test=filter-option]');
    (optsAgain[1]!.element as HTMLElement).focus();
    await w.find('[data-test=filter-menu]').trigger('keydown', { key: 'ArrowUp' });
    expect((document.activeElement as HTMLElement).dataset.filterAuthor).toBe('agent:a');
    w.unmount();
  });

  it('filters from a dropdown defaulting to All, keyed on the raw id', async () => {
    const all = mount(ReviewPanel, { props: { items, labels }, attachTo: document.body });
    expect(all.find('[data-test=filter-current]').text()).toBe('All');
    expect(all.find('[data-test=filter-menu]').exists()).toBe(false);
    await all.find('[data-test=filter-toggle]').trigger('click');
    expect(all.find('[data-test=filter-toggle]').attributes('aria-expanded')).toBe('true');
    expect(all.find('[data-test=filter-all]').text()).toContain('All');
    expect(all.find('[data-test=filter-all]').text()).toContain('3');
    const opts = all.findAll('[data-test=filter-option]');
    expect(opts.map((o) => o.find('.name').text())).toEqual(['Writing assistant', 'Mara']);
    expect(opts.map((o) => o.find('.pill').text())).toEqual(['Bot', 'Person']);
    expect(opts.map((o) => o.find('.cnt').text())).toEqual(['2', '1']);
    await opts[0]!.trigger('click');
    expect(all.emitted('show-only')).toEqual([['agent:a']]);
    expect(all.find('[data-test=filter-menu]').exists()).toBe(false);
    await all.find('[data-test=filter-toggle]').trigger('click');
    await all.find('[data-test=filter-all]').trigger('click');
    expect(all.emitted('show-all')).toHaveLength(1);
    all.unmount();

    const w = mount(ReviewPanel, { props: { items, labels, filter: new Set(['brett']) } });
    expect(w.findAll('[data-test=item]').map((i) => i.text())).toEqual([
      expect.stringContaining('Mara'),
    ]);
    expect(w.find('[data-test=filter-current]').text()).toContain('Mara');
    expect(w.find('[data-test=filter-current]').text()).toContain('Person');
    await w.find('[data-test=filter-toggle]').trigger('click');
    expect(w.findAll('[data-test=filter-option]')[1]!.classes()).toContain('sel');
  });

  it('colors each author with a distinct --ct-collab-N token, in first-seen order, never by display name', async () => {
    const many: SuggestionItem[] = ['brett', 'agent:x', 'agent:g', 'agent:y'].map((author, i) => ({
      id: `m${i}`,
      kind: 'suggestion_insert',
      author,
      ts: 't',
      text: 'x',
    }));
    const names: Record<string, string> = { 'agent:g': 'Grok Bot', 'agent:x': 'Editor bot' };
    const w = mount(ReviewPanel, {
      props: { items: many, labels: (a: string) => ({ name: names[a] ?? a }) },
    });
    await w.find('[data-test=filter-toggle]').trigger('click');
    const vars = w
      .findAll('[data-test=filter-option] .av')
      .map((e) => (e.element as HTMLElement).style.getPropertyValue('--ct-suggester'));
    // agent:g is labelled "Grok Bot" but is third seen, so it gets collab-3, not a pinned collab-1.
    expect(vars).toEqual([
      'var(--ct-collab-1)',
      'var(--ct-collab-2)',
      'var(--ct-collab-3)',
      'var(--ct-collab-4)',
    ]);
    const card = w.findAll('[data-test=item]')[2]!.element as HTMLElement;
    expect(card.style.getPropertyValue('--ct-suggester')).toBe('var(--ct-collab-3)');
    expect(w.html()).not.toContain('hsl(');
  });

  it('confirms Accept all with the count and names of the visible changes', async () => {
    const w = mount(ReviewPanel, { props: { items, labels } });
    await w.find('[data-test=accept-all]').trigger('click');
    expect(w.find('[data-test=confirm]').text()).toContain(
      'Accept 3 changes from Writing assistant and Mara?',
    );
    expect(w.emitted('decide-visible')).toBeUndefined();
    await w.find('[data-test=confirm-yes]').trigger('click');
    expect(w.emitted('decide-visible')).toEqual([['accept', items.map(key)]]);
    await w.find('[data-test=reject-all]').trigger('click');
    await w.find('[data-test=confirm-no]').trigger('click');
    expect(w.emitted('decide-visible')).toHaveLength(1);
  });

  it('locks the bulk targets when the confirmation opens', async () => {
    const w = mount(ReviewPanel, { props: { items, labels } });
    await w.find('[data-test=reject-all]').trigger('click');
    const late: SuggestionItem = {
      id: 's9',
      kind: 'suggestion_insert',
      author: 'agent:a',
      ts: 't',
      text: 'late',
    };
    await w.setProps({ items: [...items, late] });
    expect(w.find('[data-test=confirm]').text()).toContain('Reject 3 changes');
    await w.find('[data-test=confirm-yes]').trigger('click');
    expect(w.emitted('decide-visible')).toEqual([['reject', items.map(key)]]);
  });

  it('collapses to a rail with a badge of open changes', async () => {
    const w = mount(ReviewPanel, { props: { items, collapsed: true } });
    expect(w.find('[data-test=review-panel]').exists()).toBe(false);
    expect(w.find('[data-test=badge]').text()).toBe('3');
    await w.find('[data-test=expand]').trigger('click');
    expect(w.emitted('toggle-collapsed')).toHaveLength(1);
  });

  it('shows an empty state', () => {
    const w = mount(ReviewPanel, { props: { items: [] } });
    expect(w.find('[data-test=empty]').exists()).toBe(true);
    // ob8: an icon card with the mockup copy, not a single line.
    const card = w.find('.es');
    expect(card.find('.es__icon').exists()).toBe(true);
    expect(card.find('h3').text()).toBe('Nothing to review');
    expect(card.text()).toContain('keep or skip');
    expect(w.find('[data-test=counter]').text()).toBe('0 of 0');
  });

  it('Accept all locks only visible changes when an author filter is active (#50)', async () => {
    const w = mount(ReviewPanel, { props: { items, labels, filter: new Set(['brett']) } });
    await w.find('[data-test=accept-all]').trigger('click');
    expect(w.find('[data-test=confirm]').text()).toMatch(/Accept 1 change from Mara/);
    await w.find('[data-test=confirm-yes]').trigger('click');
    expect(w.emitted('decide-visible')).toEqual([['accept', [key(items[1]!)]]]);
    w.unmount();
  });

  it('keeps a short line, not the empty card, when the author filter hides every change', () => {
    const w = mount(ReviewPanel, { props: { items, filter: new Set(['nobody']) } });
    expect(w.find('.es').exists()).toBe(false);
    expect(w.find('[data-test=empty-filtered]').exists()).toBe(true);
  });

  it('shows the bot reason line on cards and omits it for people (#60, tc4/tc6)', async () => {
    const withReason: SuggestionItem[] = [
      {
        id: 's1',
        kind: 'suggestion_insert',
        author: 'agent:a',
        ts: 't',
        text: 'guttered',
        reason: 'Matches the date in Chapter 3.',
      },
      { id: 's2', kind: 'suggestion_delete', author: 'brett', ts: 't', text: 'old' },
    ];
    const w = mount(ReviewPanel, { props: { items: withReason, labels } });
    const cards = w.findAll('[data-test=item]');
    expect(cards[0]!.find('[data-test=reason-line]').text()).toContain(
      'Matches the date in Chapter 3.',
    );
    expect(cards[1]!.find('[data-test=reason-line]').exists()).toBe(false);
    const botCard = cards[0]!.element;
    expect(botCard.querySelector('.who')?.nextElementSibling?.classList.contains('q')).toBe(true);
    expect(botCard.querySelector('.q')?.nextElementSibling?.classList.contains('reason')).toBe(
      true,
    );
    expect(
      botCard.querySelector('.reason')?.nextElementSibling?.classList.contains('actions'),
    ).toBe(true);
    w.unmount();

    const longReason = 'x'.repeat(120);
    const longItems: SuggestionItem[] = [
      {
        id: 's9',
        kind: 'suggestion_insert',
        author: 'agent:a',
        ts: 't',
        text: 'word',
        reason: longReason,
      },
    ];
    const long = mount(ReviewPanel, { props: { items: longItems, labels } });
    expect(long.get('[data-test=reason-more]').text()).toBe('More');
    await long.get('[data-test=reason-more]').trigger('click');
    expect(long.get('[data-test=reason-more]').text()).toBe('Less');
    long.unmount();
  });

  it('reason line styles use --ct-* tokens for light and dark themes (#60)', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../shells/ReasonLine.vue'),
      'utf8',
    );
    expect(css).toMatch(/color:\s*var\(--ct-text-muted\)/);
    expect(css).toMatch(/color:\s*var\(--ct-accent\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
