import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import OverlapPopover from './OverlapPopover.vue';

describe('OverlapPopover (#179)', () => {
  it('lists overlapping changes and emits accept through the backdrop stack', async () => {
    const entries = [
      {
        targets: [{ kind: 'suggestion_insert' as const, id: 'b1' }],
        author: 'agent:b',
        ins: 'dimmed',
        ts: '2',
      },
      {
        targets: [{ kind: 'suggestion_insert' as const, id: 'a1' }],
        author: 'agent:a',
        ins: 'guttered',
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
    expect(w.find('[data-test=overlap-popover]').attributes('aria-label')).toBe(
      'Overlapping suggestions',
    );
    const rows = w.findAll('[data-test=overlap-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('dimmed');
    await rows[1]!.find('[data-test=overlap-accept]').trigger('click');
    expect(w.emitted('decide')).toEqual([[[{ kind: 'suggestion_insert', id: 'a1' }], 'accept']]);
    w.unmount();
  });
});
