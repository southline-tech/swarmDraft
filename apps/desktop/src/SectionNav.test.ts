import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const titles = (w: W) => w.findAll('.row:not(.row--placeholder) .title').map((r) => r.text());
const placeholderLabels = (w: W) =>
  w.findAll('.row--placeholder .placeholder-label').map((r) => r.text());
const settle = async () => {
  await flushPromises();
  await flushPromises();
};
function ctxEl(testId: string) {
  const el = document.body.querySelector(`[data-test="${testId}"]`);
  expect(el, testId).toBeTruthy();
  return el as HTMLElement;
}
function mockRowRect(w: W, id: string, top: number, height: number) {
  const target = w.get(`[data-test="section-${id}"]`).element as HTMLElement;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
  return target;
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
    expect(w.find('[data-test="new-chapter"]').attributes('aria-disabled')).toBe('true');
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
    mockRowRect(w, 'part-2', 200, 40);
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-part-2"]').trigger('dragover', { clientY: 220 });
    await w.find('[data-test="section-part-2"]').trigger('drop', { clientY: 220 });
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
    const sfc = readFileSync(resolve(__dirname, 'SectionNav.vue'), 'utf8');
    const css = sfc.slice(sfc.indexOf('<style'));
    expect(css).toMatch(/\.drop-line[\s\S]*height:\s*2px/);
    expect(css).toContain('background: var(--ct-accent)');
    expect(css).toContain('.row--drop-into');
    expect(css).toMatch(/inset 0 0 0 2px var\(--ct-accent\)/);
  });

  it('shows an accent drop line while dragging over a row (#108)', async () => {
    const w = setup();
    mockRowRect(w, 'ch-2', 80, 40);
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-ch-2"]').trigger('dragover', { clientY: 85 });
    await settle();
    expect(w.find('[data-test="drop-line-before"]').exists()).toBe(true);
    w.unmount();
  });

  it('shows an accent line after the row in the lower half (#108)', async () => {
    const w = setup();
    mockRowRect(w, 'ch-1', 60, 40);
    await w.find('[data-test="section-ch-2"]').trigger('dragstart');
    await w.find('[data-test="section-ch-1"]').trigger('dragover', { clientY: 95 });
    await settle();
    expect(w.find('[data-test="drop-line-after"]').exists()).toBe(true);
    w.unmount();
  });

  it('shows an into-part inset while dragging over a part row (#108)', async () => {
    const w = setup();
    mockRowRect(w, 'part-1', 40, 40);
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-part-1"]').trigger('dragover', { clientY: 60 });
    await settle();
    expect(w.find('[data-test="section-part-1"]').classes()).toContain('row--drop-into');
    w.unmount();
  });

  it('drops before the target when the pointer is in the upper half (#108)', async () => {
    const w = setup();
    mockRowRect(w, 'ch-1', 60, 40);
    await w.find('[data-test="section-ch-2"]').trigger('dragstart');
    await w.find('[data-test="section-ch-1"]').trigger('dragover', { clientY: 65 });
    await settle();
    expect(w.find('[data-test="drop-line-before"]').exists()).toBe(true);
    await w.find('[data-test="section-ch-1"]').trigger('drop', { clientY: 65 });
    await settle();
    expect(titles(w).slice(2, 4)).toEqual(['After the bell', 'Harbor dawn']);
    w.unmount();
  });

  it('clears the undo banner when the outline changes after a delete', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await openCtx(w, 'ch-2');
    await ctxClick(w, 'outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(w.find('[data-test="outline-undo-delete-btn"]').exists()).toBe(true);
    await openCtx(w, 'ch-1');
    await ctxClick(w, 'outline-ctx-rename');
    await w.find('[data-test="rename-input"]').setValue('Renamed chapter');
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(w.find('[data-test="outline-undo-delete-btn"]').exists()).toBe(false);
    w.unmount();
  });

  it('shows default front-matter placeholders for missing Copyright and Contents (#109)', () => {
    const w = setup();
    expect(placeholderLabels(w)).toEqual(['Add Copyright', 'Add Contents']);
    expect(w.find('[data-test="matter-placeholder-dedication"]').exists()).toBe(false);
    expect(w.find('[data-test="front-matter-group"]').attributes('aria-expanded')).toBe('false');
    w.unmount();
  });

  it('adds a section from a placeholder click and activates the editor (#109)', async () => {
    const w = setup();
    await w.find('[data-test="matter-placeholder-copyright"]').trigger('click');
    await settle();
    expect(titles(w)).toContain('Copyright');
    const id = w.props('sections').find((s) => s.title === 'Copyright')!.id;
    expect(w.emitted('activate')?.at(-1)).toEqual([id]);
    expect(placeholderLabels(w)).toEqual(['Add Contents']);
    w.unmount();
  });

  it('adds catalog front matter via per-group + New (#109, #110)', async () => {
    const w = setup();
    await w.find('[data-test="outline-new-front"]').trigger('click');
    await settle();
    await ctxEl('outline-new-dedication').click();
    await settle();
    expect(titles(w)).toContain('Dedication');
    expect(w.find('[data-test="matter-placeholder-dedication"]').exists()).toBe(false);
    const id = w.props('sections').find((s) => s.title === 'Dedication')!.id;
    expect(w.emitted('activate')?.at(-1)).toEqual([id]);
    w.unmount();
  });

  it('adds catalog back matter via back-group + New (#109, designer)', async () => {
    const w = setup();
    expect(w.find('[data-test="back-matter-group"]').exists()).toBe(true);
    await w.find('[data-test="outline-new-back"]').trigger('click');
    await settle();
    await ctxEl('outline-new-also-by').click();
    await settle();
    expect(titles(w)).toContain('Also by');
    const id = w.props('sections').find((s) => s.title === 'Also by')!.id;
    expect(w.emitted('activate')?.at(-1)).toEqual([id]);
    w.unmount();
  });

  it('does not show a footer + New control (#110)', () => {
    const w = setup();
    expect(w.find('[data-test="outline-new"]').exists()).toBe(false);
    w.unmount();
  });

  it('adds a chapter at the end of the last part via content + New default (#110)', async () => {
    const w = setup();
    await w.find('[data-test="outline-new-content"]').trigger('click');
    await settle();
    expect(w.find('[data-test="rename-input"]').exists()).toBe(true);
    await w.find('[data-test="rename-input"]').setValue('Closing harbor');
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toEqual([
      'Title page',
      'Opening arc',
      'Harbor dawn',
      'After the bell',
      'Closing harbor',
      'About the author',
    ]);
    const created = w.props('sections').find((s) => s.title === 'Closing harbor')!;
    expect(created.kind).toBe('chapter');
    expect(created.parentId).toBe('part-1');
    w.unmount();
  });

  it('adds a chapter to the last part when multiple parts exist (#110)', async () => {
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
    await w.find('[data-test="outline-new-content"]').trigger('click');
    await settle();
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
    await settle();
    const created = w.props('sections').find((x) => x.title === 'New chapter')!;
    expect(created.parentId).toBe('part-2');
    w.unmount();
  });

  it('adds a part via content + New split menu (#110)', async () => {
    const w = setup();
    await w.find('[data-test="outline-new-content-split"]').trigger('click');
    await settle();
    await ctxEl('outline-new-part').click();
    await settle();
    expect(w.find('[data-test="rename-input"]').exists()).toBe(true);
    await w.find('[data-test="rename-input"]').setValue('Middle arc');
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toEqual([
      'Title page',
      'Opening arc',
      'Harbor dawn',
      'After the bell',
      'Middle arc',
      'About the author',
    ]);
    const created = w.props('sections').find((s) => s.title === 'Middle arc')!;
    expect(created.kind).toBe('part');
    expect(created.parentId).toBeUndefined();
    w.unmount();
  });

  it('supports arrow keys and Escape on content + New menu (#110)', async () => {
    const w = setup();
    await w.find('[data-test="outline-new-content-split"]').trigger('click');
    await settle();
    const menu = ctxEl('outline-new-menu-content');
    const items = menu.querySelectorAll('[role=menuitem]');
    expect(items.length).toBe(2);
    expect(document.activeElement).toBe(items[0]);
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(w.find('[data-test="outline-new-menu-content"]').exists()).toBe(false);
    w.unmount();
  });

  it('roves keyboard focus through matter placeholders (#109 designer)', async () => {
    const w = setup({ selectedId: 'title' });
    await w.find('[data-test="section-title"]').trigger('keydown', { key: 'ArrowDown' });
    await settle();
    expect(document.activeElement?.getAttribute('data-test')).toBe('matter-placeholder-copyright');
    await w.find('[data-test="matter-placeholder-copyright"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toContain('Copyright');
    w.unmount();
  });

  it('supports arrow keys and Escape on per-group + New menus (designer)', async () => {
    const w = setup();
    await w.find('[data-test="outline-new-front"]').trigger('click');
    await settle();
    const menu = ctxEl('outline-new-menu-front');
    const items = menu.querySelectorAll('[role=menuitem]');
    expect(items.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(items[0]);
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1] ?? items[0]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(w.find('[data-test="outline-new-menu-front"]').exists()).toBe(false);
    w.unmount();
  });

  it('styles matter placeholders with muted tokens (#109)', () => {
    const sfc = readFileSync(resolve(__dirname, 'SectionNav.vue'), 'utf8');
    const css = sfc.slice(sfc.indexOf('<style'));
    expect(css).toContain('.row--placeholder');
    expect(css).toMatch(/\.row--placeholder[\s\S]*color:\s*var\(--ct-text-muted\)/);
    expect(css).toContain('border: 1px dashed var(--ct-border-strong)');
    expect(css).toMatch(/\.outline-new__btn[\s\S]*border:\s*1px dashed var\(--ct-border\)/);
    expect(css).toMatch(
      /\.outline-new__btn:hover[\s\S]*var\(--ct-selected-bg\)[\s\S]*var\(--ct-accent\)/,
    );
  });

  it('drops after a part row as a sibling, not under the next chapter (#108)', async () => {
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
    mockRowRect(w, 'part-1', 40, 40);
    await w.find('[data-test="section-part-2"]').trigger('dragstart');
    await w.find('[data-test="section-part-1"]').trigger('dragover', { clientY: 75 });
    await settle();
    expect(w.find('[data-test="drop-line-after"]').exists()).toBe(true);
    await w.find('[data-test="section-part-1"]').trigger('drop', { clientY: 75 });
    await settle();
    expect(titles(w)).toEqual([
      'Title page',
      'Opening arc',
      'Harbor dawn',
      'After the bell',
      'Part Two',
      'About the author',
    ]);
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
