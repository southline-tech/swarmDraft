import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SplitChapterPopover from './SplitChapterPopover.vue';

describe('SplitChapterPopover (#304)', () => {
  it('confirms from form submit on the title field, not global Enter', async () => {
    const w = mount(SplitChapterPopover, {
      props: { x: 10, y: 10, title: 'Twelve', removeLine: false },
      attachTo: document.body,
    });
    await w.vm.$nextTick();
    const form = document.body.querySelector(
      '[data-test="split-chapter-popover"]',
    ) as HTMLFormElement;
    expect(form).toBeTruthy();
    form.requestSubmit();
    await w.vm.$nextTick();
    expect(w.emitted('confirm')).toBeTruthy();
    expect(w.emitted('confirm')![0]).toEqual([{ title: 'Twelve', removeLine: false }]);
    w.unmount();
  });

  it('exposes Split chapter as the dialog accessible name', async () => {
    const w = mount(SplitChapterPopover, {
      props: { x: 0, y: 0, title: '', removeLine: true },
      attachTo: document.body,
    });
    await w.vm.$nextTick();
    const dlg = document.body.querySelector('[data-test="split-chapter-popover"]')!;
    expect(dlg.getAttribute('aria-labelledby')).toBe('split-chapter-heading');
    expect(document.getElementById('split-chapter-heading')?.textContent).toBe('Split chapter');
    w.unmount();
  });
});
