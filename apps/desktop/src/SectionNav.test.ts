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

describe('SectionNav', () => {
  it('lists parts and chapters nested in order', () => {
    const w = setup();
    expect(titles(w)).toEqual([
      'Title page',
      'Part One',
      'Chapter 1',
      'Chapter 2',
      'About the author',
    ]);
    expect(w.find('[data-test="add-scene"]').exists()).toBe(false);
    w.unmount();
  });

  it('selects, adds a chapter and renames it', async () => {
    const w = setup({ selectedId: 'part-1' });
    await w.find('[data-test="new-chapter"]').trigger('click');
    await settle();
    const added = w.props('sections').find((s) => s.title === 'New chapter')!;
    expect(added).toMatchObject({ kind: 'chapter', parentId: 'part-1' });
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Harbor\u0007 at   dusk');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toContain('Harbor at dusk');
    w.unmount();
  });

  it('a row click asks to focus the editor; keyboard moves and renaming do not', async () => {
    const w = setup();
    await w.find('[data-test="section-ch-1"]').trigger('click');
    expect(w.emitted('activate')).toEqual([['ch-1']]);
    await w.find('[data-test="section-ch-1"]').trigger('keydown', { key: 'ArrowDown' });
    await w.find('[data-test="new-chapter"]').trigger('click');
    await settle();
    expect(w.emitted('activate')).toHaveLength(1);
    w.unmount();
  });

  it('reorders with the arrow buttons', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await w.find('[data-test="move-up"]').trigger('click');
    await settle();
    expect(titles(w).slice(2, 4)).toEqual(['Chapter 2', 'Chapter 1']);
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

  it('moves into another parent without dragging', async () => {
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
    await w.find('[data-test="move-to"]').setValue('part-2');
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
    expect(titles(w).slice(2, 4)).toEqual(['Chapter 2', 'Chapter 1']);
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
    await w.find('[data-test="delete"]').trigger('click');
    await settle();
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
    await w.find('[data-test="delete"]').trigger('click');
    const dialog = w.find('[data-test="confirm-delete"]');
    expect(dialog.text()).toContain('2 section(s) inside it');
    await w.find('[data-test="confirm-delete-promote"]').trigger('click');
    await settle();
    expect(titles(w)).toEqual(['Title page', 'Chapter 1', 'Chapter 2', 'About the author']);

    await w.setProps({ selectedId: 'ch-1' });
    await w.find('[data-test="delete"]').trigger('click');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(titles(w)).not.toContain('Chapter 1');
    w.unmount();
  });

  it('moves the selection off a just-deleted section', async () => {
    const w = setup({ selectedId: 'ch-2' });
    await w.find('[data-test="delete"]').trigger('click');
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
    await w.find('[data-test="move-up"]').trigger('click');
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
    await w.find('[data-test="move-up"]').trigger('click');
    await settle();
    const msg = w.find('[data-test="save-error"]').text();
    expect(msg).not.toMatch(/SQLITE|secret/);
    log.mockRestore();
    w.unmount();
  });

  it('adds a chapter from the New chapter row (#52)', async () => {
    const saved = vi.fn(async (s: Section[]) => s);
    const w = setup({ selectedId: 'ch-1', save: saved });
    const before = w.props('sections').length;
    await w.find('[data-test="new-chapter"]').trigger('click');
    await settle();
    expect(saved).toHaveBeenCalled();
    expect(w.props('sections').length).toBe(before + 1);
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
