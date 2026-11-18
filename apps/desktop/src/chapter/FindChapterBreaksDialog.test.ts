import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('keeps the skip region mounted so a later message can be announced', async () => {
    w = mountDialog([row()]);
    await w.vm.$nextTick();
    const skip = w.get('[data-test="find-breaks-skip"]');
    expect(skip.attributes('role')).toBe('status');
    expect(skip.attributes('data-empty')).toBe('true');
    expect(skip.text().trim()).toBe('');
    await w.setProps({
      skipMessage: 'Skipped 1 break: resolve the change at that spot first',
      skipJumpKey: 'c1:2',
    });
    expect(w.get('[data-test="find-breaks-skip"]').element).toBe(skip.element);
    expect(skip.attributes('data-empty')).toBeUndefined();
    expect(skip.text()).toContain('Skipped 1 break: resolve the change at that spot first');
    w.unmount();
  });

  it('names each remove-line checkbox with its title', async () => {
    w = mountDialog([row(), row({ key: 'c1:4', title: 'Chapter Three' })]);
    await w.vm.$nextTick();
    const removes = w.findAll('[data-test="find-breaks-remove-line"]');
    expect(removes[0]!.attributes('aria-label')).toBe('Remove “Chapter Two” from the text');
    expect(removes[1]!.attributes('aria-label')).toBe('Remove “Chapter Three” from the text');
    expect(removes[0]!.attributes('aria-label')).not.toBe(removes[1]!.attributes('aria-label'));
    w.unmount();
  });

  it('ignores a repeated Enter and a confirm while a batch is applying', async () => {
    w = mountDialog([row()], null);
    await w.vm.$nextTick();
    await w
      .get('[data-test="find-breaks-dialog"]')
      .trigger('keydown', { key: 'Enter', repeat: true });
    expect(w.emitted('confirm')).toBeUndefined();
    await w.setProps({ busy: true });
    await w.get('[data-test="find-breaks-dialog"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.get('[data-test="find-breaks-confirm"]').attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('keeps Split selected inside a short window', async () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      row({ key: `c1:${i + 1}`, title: `Chapter ${i + 2}`, blockIndex: i + 1 }),
    );
    const dom = (
      window as unknown as {
        happyDOM?: { setViewport: (v: { width: number; height: number }) => void };
      }
    ).happyDOM;
    dom?.setViewport({ width: 900, height: 500 });
    document.documentElement.style.setProperty('--ct-space-6', '24px');
    document.documentElement.style.setProperty('--ct-space-3', '12px');
    document.documentElement.style.setProperty('--ct-space-2', '8px');
    document.documentElement.style.setProperty('--ct-space-8', '32px');
    w = mountDialog(rows);
    await w.vm.$nextTick();
    const dialog = w.get('[data-test="find-breaks-dialog"]').element as HTMLElement;
    const list = w.get('.find-breaks__list').element as HTMLElement;
    const confirm = w.get('[data-test="find-breaks-confirm"]').element as HTMLElement;
    const css = readFileSync(resolve(__dirname, 'FindChapterBreaksDialog.vue'), 'utf8');
    expect(css).toMatch(/box-sizing:\s*border-box/);
    expect(css).toMatch(/max-height:\s*min\(32rem,\s*calc\(100vh - 2 \* var\(--ct-space-6\)\)\)/);
    expect(css).toMatch(/overflow:\s*auto/);
    expect(css).toMatch(/\.find-breaks__list[^{]*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.find-breaks__actions[^{]*\{[^}]*flex:\s*none/);
    // Short window: the card cap is the viewport minus the scrim's padding (24px × 2).
    const cap = Math.min(32 * 16, window.innerHeight - 48);
    expect(cap).toBeLessThanOrEqual(500 - 48);
    expect(dialog.contains(list)).toBe(true);
    expect(dialog.contains(confirm)).toBe(true);
    expect(confirm.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(0);
    w.unmount();
  });
});
