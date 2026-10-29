import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { Section } from '@coauthor/schema';
import SectionNav from './SectionNav.vue';
import { SAMPLE_MANUSCRIPT_ID, sampleOutline } from './fixtures/outline-sample';

function setup(
  opts: {
    selectedId?: string;
    sections?: Section[];
    save?: (s: Section[]) => unknown;
  } = {},
) {
  const w = mount(SectionNav, {
    props: {
      manuscriptId: SAMPLE_MANUSCRIPT_ID,
      sections: opts.sections ?? sampleOutline(),
      ...(opts.selectedId ? { selectedId: opts.selectedId } : {}),
      ...(opts.save ? { save: opts.save as never } : {}),
      'onUpdate:sections': (s: Section[]) => w.setProps({ sections: s }),
      onSelect: (id: string) => w.setProps({ selectedId: id }),
    },
    attachTo: document.body,
  });
  return w;
}
type W = ReturnType<typeof setup>;
const titles = (w: W) => w.findAll('.row .title').map((r) => r.text());
const settle = async () => {
  await flushPromises();
  await flushPromises();
};
function ctxEl(testId: string) {
  const el = document.body.querySelector(`[data-test="${testId}"]`);
  expect(el, testId).toBeTruthy();
  return el as HTMLElement;
}
async function openCtx(w: W, id: string) {
  await w.find(`[data-test="section-${id}"]`).trigger('contextmenu', { clientX: 80, clientY: 120 });
  await settle();
}
async function ctxClick(_w: W, testId: string) {
  ctxEl(testId).click();
  await settle();
}

describe('SectionNav', () => {
  it('lists parts and chapters nested in order', () => {
    const w = setup();
    expect(titles(w)).toEqual([
      'Title page',
      'Opening arc',
      'Harbor dawn',
      'After the bell',
      'About the author',
    ]);
    expect(w.find('[data-test="add-scene"]').exists()).toBe(false);
    expect(w.find('[data-test="move-up"]').exists()).toBe(false);
    expect(w.find('[data-test="new-chapter"]').exists()).toBe(false);
    w.unmount();
  });

  it('Add inserts a sibling after the selection and starts rename', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-add');
    expect(w.find('[data-test="rename-input"]').exists()).toBe(true);
    await w.find('[data-test="rename-input"]').setValue('New chapter');
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toEqual([
      'Title page',
      'Opening arc',
      'Harbor dawn',
      'New chapter',
      'After the bell',
      'About the author',
    ]);
    w.unmount();
  });

  it('undo restores a deleted section', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(titles(w)).not.toContain('After the bell');
    await w.find('[data-test="outline-undo-delete-btn"]').trigger('click');
    await settle();
    expect(titles(w)).toContain('After the bell');
    w.unmount();
  });

  it('keeps the undo banner when restore save fails', async () => {
    let saves = 0;
    const w = setup({
      selectedId: 'ch-2',
      save: () => {
        saves += 1;
        if (saves > 1) throw new Error('save refused');
      },
    });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    await w.find('[data-test="outline-undo-delete-btn"]').trigger('click');
    await settle();
    expect(w.find('[data-test="outline-undo-delete-btn"]').exists()).toBe(true);
    w.unmount();
  });

  it('renames from the context menu', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-rename');
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Harbor\u0007 at   dusk');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toContain('Harbor at dusk');
    w.unmount();
  });

  it('a row click and arrow moves ask to focus the editor', async () => {
    const w = setup();
    await w.find('[data-test="section-ch-1"]').trigger('click');
    expect(w.emitted('activate')).toEqual([['ch-1']]);
    await w.find('[data-test="section-ch-1"]').trigger('keydown', { key: 'ArrowDown' });
    expect(w.emitted('activate')).toEqual([['ch-1'], ['ch-2']]);
    w.unmount();
  });

  it('Edit in the context menu activates the section', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-edit');
    expect(w.emitted('activate')).toEqual([['ch-1']]);
    w.unmount();
  });

  it('opens the context menu with Shift+F10 and the Menu key', async () => {
    const w = setup({ selectedId: 'ch-1' });
    const row = w.find('[data-test="section-ch-1"]');
    await row.trigger('keydown', { key: 'F10', shiftKey: true });
    await settle();
    expect(document.body.querySelector('[data-test="outline-context-menu"]')).toBeTruthy();
    ctxEl('outline-context-menu').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    await row.trigger('keydown', { key: 'ContextMenu' });
    await settle();
    expect(document.body.querySelector('[data-test="outline-context-menu"]')).toBeTruthy();
    w.unmount();
  });

  it('disables move up at the top with aria-disabled styling', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    const up = ctxEl('outline-ctx-move-up');
    expect(up.getAttribute('aria-disabled')).toBe('true');
    w.unmount();
  });

  it('reorders from the context menu', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-move-up');
    await settle();
    expect(titles(w).slice(2, 4)).toEqual(['After the bell', 'Harbor dawn']);
    w.unmount();
  });

  it('drags a chapter into another part', async () => {
    let s = sampleOutline();
    s = [
      ...s,
      {
        id: 'part-2',
        kind: 'part',
        title: 'Part Two',
        docId: 'manuscript/sample/section/part-2',
      },
    ];
    const w = setup({ sections: s });
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-part-2"]').trigger('drop');
    await settle();
    expect(w.props('sections').find((x) => x.id === 'ch-1')!.parentId).toBe('part-2');
    w.unmount();
  });

  it('moves into another part from the context menu', async () => {
    let s = sampleOutline();
    s = [
      ...s,
      {
        id: 'part-2',
        kind: 'part',
        title: 'Part Two',
        docId: 'manuscript/sample/section/part-2',
      },
    ];
    const w = setup({ sections: s, selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-move-to-part');
    await ctxClick(w, 'outline-ctx-part-part-2');
    await settle();
    expect(w.props('sections').find((x) => x.id === 'ch-1')!.parentId).toBe('part-2');
    w.unmount();
  });

  it('navigates and reorders with the keyboard', async () => {
    const w = setup({ selectedId: 'ch-1' });
    const row = (id: string) => w.find(`[data-test="section-${id}"]`);
    await row('ch-1').trigger('keydown', { key: 'ArrowDown' });
    expect(w.props('selectedId')).toBe('ch-2');
    await row('ch-2').trigger('keydown', { key: 'ArrowUp' });
    expect(w.props('selectedId')).toBe('ch-1');
    await row('ch-1').trigger('keydown', { key: 'ArrowDown', altKey: true });
    await settle();
    expect(titles(w).slice(2, 4)).toEqual(['After the bell', 'Harbor dawn']);
    await row('ch-1').trigger('keydown', { key: 'F2' });
    expect(w.find('[data-test="rename-input"]').exists()).toBe(true);
    w.unmount();
  });

  it('refuses to drag a section into its own subtree', async () => {
    const w = setup();
    const before = w.props('sections');
    await w.find('[data-test="section-part-1"]').trigger('dragstart');
    await w.find('[data-test="section-ch-1"]').trigger('drop');
    await settle();
    expect(w.props('sections')).toEqual(before);
    w.unmount();
  });

  it('opens the delete dialog with Cancel first and focused; Escape closes it', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-delete');
    const buttons = w.findAll('[data-test="confirm-delete"] button');
    expect(buttons[0]!.attributes('data-test')).toBe('confirm-delete-cancel');
    expect(document.activeElement).toBe(buttons[0]!.element);
    await w.find('[data-test="confirm-delete"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(w.find('[data-test="confirm-delete"]').exists()).toBe(false);
    expect(titles(w)).toHaveLength(5);
    w.unmount();
  });

  it('asks before deleting and applies the child rule', async () => {
    const w = setup({ selectedId: 'part-1' });
    await openCtx(w, 'part-1');
    await ctxClick(w, 'outline-ctx-delete');
    const dialog = w.find('[data-test="confirm-delete"]');
    expect(dialog.text()).toContain('2 section(s) inside it');
    await w.find('[data-test="confirm-delete-promote"]').trigger('click');
    await settle();
    expect(titles(w)).toEqual(['Title page', 'Harbor dawn', 'After the bell', 'About the author']);

    await w.setProps({ selectedId: 'ch-1' });
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(titles(w)).not.toContain('Harbor dawn');
    w.unmount();
  });

  it('deletes with the Delete key after confirmation', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await w.find('[data-test="section-ch-2"]').trigger('keydown', { key: 'Delete' });
    await settle();
    expect(w.find('[data-test="confirm-delete"]').exists()).toBe(true);
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(titles(w)).not.toContain('After the bell');
    w.unmount();
  });

  it('moves the selection off a just-deleted section', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(w.props('selectedId')).toBe('ch-1');
    w.unmount();
  });

  it('keeps the outline unchanged and shows an error when saving fails', async () => {
    const w = setup({
      selectedId: 'ch-2',
      save: () => Promise.reject(new Error('disk full')),
    });
    const before = w.props('sections');
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-move-up');
    await settle();
    expect(w.props('sections')).toBe(before);
    expect(w.find('[data-test="save-error"]').text()).toContain('Not saved');
    w.unmount();
  });

  it('never shows raw error text when an outline save fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = setup({
      selectedId: 'ch-2',
      save: () => Promise.reject(new Error('SQLITE_IOERR at C:\\secret\\coauthor.db')),
    });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-move-up');
    await settle();
    const msg = w.find('[data-test="save-error"]').text();
    expect(msg).not.toMatch(/SQLITE|secret/);
    log.mockRestore();
    w.unmount();
  });

  it('renders corrupt input without hanging and flags it', async () => {
    const corrupt: Section[] = [
      { id: 'a', kind: 'part', title: 'A', docId: 'd/a', parentId: 'b' },
      { id: 'b', kind: 'part', title: 'B\u0000', docId: 'd/b', parentId: 'a' },
      { id: 'c', kind: 'chapter', title: 'C', docId: 'd/c', parentId: 'a' },
      { id: 'c', kind: 'chapter', title: 'C again', docId: 'd/c2' },
    ];
    const w = setup({ sections: corrupt });
    expect(titles(w).sort()).toEqual(['A', 'B', 'C', 'C again']);
    expect(w.find('[data-test="outline-repaired"]').exists()).toBe(true);
    w.unmount();
  });

  it('styles the drop indicator as a 2px accent line (#108)', () => {
    const sfc = readFileSync(new URL('./SectionNav.vue', import.meta.url), 'utf8');
    const css = sfc.slice(sfc.indexOf('<style'));
    expect(css).toMatch(/\.drop-line[\s\S]*height:\s*2px/);
    expect(css).toContain('background: var(--ct-accent)');
  });

  it('shows an accent drop line while dragging over a row (#108)', async () => {
    const w = setup();
    const target = w.get('[data-test="section-ch-2"]').element as HTMLElement;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 80,
      height: 40,
      bottom: 120,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect);
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-ch-2"]').trigger('dragover', { clientY: 85 });
    await settle();
    expect(w.find('[data-test="drop-line-before"]').exists()).toBe(true);
    w.unmount();
  });

  it('drops before the target when the pointer is in the upper half (#108)', async () => {
    const w = setup();
    const target = w.get('[data-test="section-ch-1"]').element as HTMLElement;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 60,
      height: 40,
      bottom: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 60,
      toJSON: () => ({}),
    } as DOMRect);
    await w.find('[data-test="section-ch-2"]').trigger('dragstart');
    await w.find('[data-test="section-ch-1"]').trigger('dragover', { clientY: 65 });
    await settle();
    expect(w.find('[data-test="drop-line-before"]').exists()).toBe(true);
    await w.find('[data-test="section-ch-1"]').trigger('drop');
    await settle();
    expect(titles(w).slice(2, 4)).toEqual(['After the bell', 'Harbor dawn']);
    w.unmount();
  });
});

describe('repair notice', () => {
  it('says the next change saves the repair', async () => {
    const outline = sampleOutline();
    const broken = outline.map((s, i) => (i === 1 ? { ...s, parentId: s.id } : s));
    const open = setup({ sections: broken });
    expect(open.find('[data-test="outline-repaired"]').text()).toContain('Your next change saves');
    open.unmount();
  });
});
