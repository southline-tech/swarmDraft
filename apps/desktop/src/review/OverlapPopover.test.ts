import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OverlapPopover from './OverlapPopover.vue';

describe('OverlapPopover (#179)', () => {
  it('lists overlapping changes and emits accept through the backdrop stack', async () => {
    const entries = [
      {
        targets: [{ kind: 'suggestion_insert' as const, id: 'b1' }],
        author: 'agent:b',
        ins: 'dimmed',
        changeType: 'Insert' as const,
        ts: '2',
      },
      {
        targets: [{ kind: 'suggestion_insert' as const, id: 'a1' }],
        author: 'agent:a',
        ins: 'guttered',
        changeType: 'Insert' as const,
        ts: '1',
      },
    ];
    const w = mount(OverlapPopover, {
      props: {
        x: 10,
        y: 20,
        entries,
        labels: (a) => ({ name: a === 'agent:a' ? 'Alpha' : 'Beta', agent: true }),
      },
      attachTo: document.body,
    });
    const dialog = w.find('[data-test=overlap-popover]');
    expect(dialog.attributes('tabindex')).toBe('0');
    expect(w.find('[data-test=overlap-title]').text()).toBe('Overlapping suggestions');
    expect(w.find('[data-test=overlap-sort-hint]').text()).toBe('Newest first');
    const rows = w.findAll('[data-test=overlap-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes('tabindex')).toBe('-1');
    expect(rows[0]!.text()).toContain('dimmed');
    expect(rows[0]!.find('[data-test=overlap-change-type]').text()).toBe('Insert');
    expect(w.find('.bar').exists()).toBe(true);
    await rows[1]!.find('[data-test=overlap-accept]').trigger('click');
    expect(w.emitted('decide')).toEqual([[[{ kind: 'suggestion_insert', id: 'a1' }], 'accept']]);
    w.unmount();
  });

  it('moves roving focus between rows with arrow keys', async () => {
    const entries = [
      {
        targets: [{ kind: 'suggestion_delete' as const, id: 'b1' }],
        author: 'agent:b',
        del: 'x',
        changeType: 'Delete' as const,
        ts: '2',
      },
      {
        targets: [{ kind: 'format_change' as const, id: 'a1' }],
        author: 'brett',
        format: 'Bold on',
        changeType: 'Format' as const,
        ts: '1',
      },
    ];
    const w = mount(OverlapPopover, {
      props: { x: 0, y: 0, entries },
      attachTo: document.body,
    });
    await flushPromises();
    const dialog = w.get('[data-test=overlap-popover]');
    (dialog.element as HTMLElement).focus();
    await dialog.trigger('keydown', { key: 'ArrowDown' });
    const rows = w.findAll('[data-test=overlap-row]');
    expect(rows[0]!.element).toBe(document.activeElement);
    (rows[0]!.element as HTMLElement).focus();
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' });
    expect(rows[1]!.element).toBe(document.activeElement);
    w.unmount();
  });
});
