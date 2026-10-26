import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SuggestionItem } from '@coauthor/editor';
import ReviewPanel from './ReviewPanel.vue';

const items: SuggestionItem[] = [
  { id: 's1', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'flickered' },
  { id: 's2', kind: 'suggestion_delete', author: 'brett', ts: 't', text: 'glowed' },
  { id: 's3', kind: 'suggestion_insert', author: 'agent:a', ts: 't', text: 'fell' },
];
const key = (i: SuggestionItem) => `${i.author}\u0000${i.id}`;
const labels = { 'agent:a': 'Writing assistant', brett: 'Mara' };

describe('ReviewPanel (RAD-258)', () => {
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

  it('lists Everyone and each author with counts, filtering on the raw id', async () => {
    const w = mount(ReviewPanel, { props: { items, labels, filter: new Set(['brett']) } });
    expect(w.findAll('[data-test=item]').map((i) => i.text())).toEqual([
      expect.stringContaining('Mara'),
    ]);
    expect(w.find('[data-test=filter-all]').text()).toContain('Everyone');
    expect(w.find('[data-test=filter-all]').text()).toContain('3');
    const opts = w.findAll('[data-test=filter-option]');
    expect(opts.map((o) => o.find('.name').text())).toEqual(['Writing assistant', 'Mara']);
    expect(opts.map((o) => o.find('.cnt').text())).toEqual(['2', '1']);
    expect(opts[1]!.classes()).toContain('sel');
    await opts[0]!.trigger('click');
    expect(w.emitted('toggle-author')).toEqual([['agent:a']]);
    await w.find('[data-test=filter-all]').trigger('click');
    expect(w.emitted('show-all')).toHaveLength(1);
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
    expect(w.find('[data-test=counter]').text()).toBe('0 of 0');
  });
});
