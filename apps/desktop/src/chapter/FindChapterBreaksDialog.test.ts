import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FindChapterBreaksDialog from './FindChapterBreaksDialog.vue';
import type { FindBreakRow } from './chapter-app-handlers';

function row(partial: Partial<FindBreakRow> = {}): FindBreakRow {
  return {
    key: 'c1:2',
    chapterId: 'c1',
    blockIndex: 2,
    sourceTitle: 'One',
    title: 'Chapter Two',
    snippet: 'The road went on.',
    selected: true,
    removeLine: true,
    ...partial,
  };
}

function mountDialog(rows: FindBreakRow[], skipMessage: string | null = null) {
  return mount(FindChapterBreaksDialog, {
    props: {
      rows,
      skipMessage,
      skipJumpKey: skipMessage ? rows[0]?.key : null,
      'onUpdate:rows': (next: FindBreakRow[]) => w.setProps({ rows: next }),
    },
    attachTo: document.body,
  });
}

let w: ReturnType<typeof mountDialog>;

describe('Find chapter breaks dialog (#305)', () => {
  it('lists the proposal and jumps without closing', async () => {
    w = mountDialog([row(), row({ key: 'c1:4', title: 'Chapter Three', removeLine: false })]);
    await w.vm.$nextTick();
    expect(document.getElementById('find-breaks-heading')?.textContent).toBe('Find chapter breaks');
    expect(w.findAll('[data-test="find-breaks-include"]')).toHaveLength(2);
    expect((w.get('[data-test="find-breaks-include"]').element as HTMLInputElement).checked).toBe(
      true,
    );
    expect(w.text()).toContain('From “One”');
    expect(w.text()).toContain('The road went on.');
    expect(w.text()).toContain('Remove this line from the text (use it as the title)');
    const removes = w.findAll('[data-test="find-breaks-remove-line"]');
    expect((removes[0]!.element as HTMLInputElement).checked).toBe(true);
    expect((removes[1]!.element as HTMLInputElement).checked).toBe(false);
    await w.get('[data-test="find-breaks-row"]').trigger('click');
    expect(w.emitted('show')?.[0]).toEqual(['c1:2']);
    expect(w.emitted('close')).toBeUndefined();
    w.unmount();
  });

  it('cancels on Esc and splits on Enter when a row is checked', async () => {
    w = mountDialog([row()]);
    await w.vm.$nextTick();
    await w.get('[data-test="find-breaks-dialog"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('confirm')).toHaveLength(1);
    await w.get('[data-test="find-breaks-dialog"]').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('does not split when every box is off', async () => {
    w = mountDialog([row({ selected: false })]);
    await w.vm.$nextTick();
    expect(w.get('[data-test="find-breaks-confirm"]').attributes('disabled')).toBeDefined();
    await w.get('[data-test="find-breaks-dialog"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('confirm')).toBeUndefined();
    w.unmount();
  });

  it('shows the empty state without Split', async () => {
    w = mountDialog([]);
    await w.vm.$nextTick();
    expect(w.get('[data-test="find-breaks-empty"]').text()).toBe('No chapter breaks found.');
    expect(w.find('[data-test="find-breaks-confirm"]').exists()).toBe(false);
    await w.get('[data-test="find-breaks-close"]').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('keeps a skip notice with a jump control', async () => {
    w = mountDialog([row()], 'Skipped 1 break: resolve the change at that spot first');
    await w.vm.$nextTick();
    expect(w.get('[data-test="find-breaks-skip"]').text()).toContain(
      'Skipped 1 break: resolve the change at that spot first',
    );
    await w.get('[data-test="find-breaks-skip-show"]').trigger('click');
    expect(w.emitted('show')?.[0]).toEqual(['c1:2']);
    expect(w.emitted('close')).toBeUndefined();
    w.unmount();
  });
});
