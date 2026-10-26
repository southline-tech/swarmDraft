import { describe, expect, it } from 'vitest';
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
  it('lists parts, chapters and scenes nested in order', () => {
    const w = setup();
    expect(titles(w)).toEqual([
      'Title page',
      'Part One',
      'Chapter 1',
      'Scene 1',
      'Scene 2',
      'Chapter 2',
      'About the author',
    ]);
    expect(w.find('[data-test="section-sc-1"]').attributes('style')).toContain('3rem');
    expect(w.find('[data-test="add-scene"]').attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('selects, adds a scene into the selected chapter and renames it', async () => {
    const w = setup();
    await w.find('[data-test="section-ch-2"]').trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['ch-2']);
    await w.find('[data-test="add-scene"]').trigger('click');
    await settle();
    const s = w.props('sections');
    const added = s[s.length - 2]!;
    expect(added).toMatchObject({ kind: 'scene', parentId: 'ch-2' });
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Harbor\u0007 at   dusk');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(titles(w)).toContain('Harbor at dusk');
    w.unmount();
  });

  it('reorders with the arrow buttons', async () => {
    const w = setup({ selectedId: 'sc-2' });
    await w.find('[data-test="move-up"]').trigger('click');
    await settle();
    expect(titles(w).slice(3, 5)).toEqual(['Scene 2', 'Scene 1']);
    w.unmount();
  });

  it('drags a scene into another chapter', async () => {
    const w = setup();
    await w.find('[data-test="section-sc-1"]').trigger('dragstart');
    await w.find('[data-test="section-ch-2"]').trigger('drop');
    await settle();
    const moved = w.props('sections').find((x) => x.id === 'sc-1')!;
    expect(moved.parentId).toBe('ch-2');
    expect(titles(w).slice(2, 6)).toEqual(['Chapter 1', 'Scene 2', 'Chapter 2', 'Scene 1']);
    w.unmount();
  });

  it('moves into another parent without dragging', async () => {
    const w = setup({ selectedId: 'sc-1' });
    const options = w.findAll('[data-test="move-to"] option').map((o) => o.text());
    expect(options).toEqual(['…', 'Chapter: Chapter 1', 'Chapter: Chapter 2']);
    await w.find('[data-test="move-to"]').setValue('ch-2');
    await settle();
    expect(w.props('sections').find((x) => x.id === 'sc-1')!.parentId).toBe('ch-2');
    w.unmount();
  });

  it('navigates and reorders with the keyboard', async () => {
    const w = setup({ selectedId: 'ch-1' });
    const row = (id: string) => w.find(`[data-test="section-${id}"]`);
    expect(row('ch-1').attributes('tabindex')).toBe('0');
    expect(row('sc-1').attributes('tabindex')).toBe('-1');
    await row('ch-1').trigger('keydown', { key: 'ArrowDown' });
    expect(w.props('selectedId')).toBe('sc-1');
    await row('sc-1').trigger('keydown', { key: 'ArrowLeft' });
    expect(w.props('selectedId')).toBe('ch-1');
    await row('ch-1').trigger('keydown', { key: 'ArrowRight' });
    expect(w.props('selectedId')).toBe('sc-1');
    await row('sc-1').trigger('keydown', { key: 'ArrowRight' }); // no children: stays
    expect(w.props('selectedId')).toBe('sc-1');
    await row('sc-1').trigger('keydown', { key: 'ArrowLeft' });
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
    await w.find('[data-test="section-ch-1"]').trigger('dragstart');
    await w.find('[data-test="section-sc-2"]').trigger('drop');
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
    expect(titles(w)).toHaveLength(7);
    expect(document.activeElement).toBe(w.find('[data-test="section-ch-1"]').element);
    w.unmount();
  });

  it('asks before deleting and applies the child rule', async () => {
    const w = setup({ selectedId: 'ch-1' });
    await w.find('[data-test="delete"]').trigger('click');
    const dialog = w.find('[data-test="confirm-delete"]');
    expect(dialog.text()).toContain('2 section(s) inside it');
    expect(dialog.text()).toContain(
      "Its text, comments and suggestions (including pending bot suggestions) can't be recovered.",
    );
    const del = w.find('[data-test="confirm-delete-all"]');
    expect(del.text()).toBe('Delete');
    expect(del.classes()).toContain('danger');
    // Scenes cannot move up into a part, so "keep what is inside" is not offered.
    expect(w.find('[data-test="confirm-delete-promote"]').attributes('disabled')).toBeDefined();
    await w.find('[data-test="confirm-delete-cancel"]').trigger('click');
    expect(titles(w)).toHaveLength(7);
    await w.find('[data-test="delete"]').trigger('click');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(titles(w)).toEqual(['Title page', 'Part One', 'Chapter 2', 'About the author']);
    expect(w.props('selectedId')).toBe('part-1');

    await w.find('[data-test="delete"]').trigger('click');
    await w.find('[data-test="confirm-delete-promote"]').trigger('click');
    await settle();
    expect(titles(w)).toEqual(['Title page', 'Chapter 2', 'About the author']);
    w.unmount();
  });

  it('keeps the outline unchanged and shows an error when saving fails', async () => {
    const w = setup({
      selectedId: 'sc-2',
      save: () => Promise.reject(new Error('disk full')),
    });
    const before = w.props('sections');
    await w.find('[data-test="move-up"]').trigger('click');
    await settle();
    expect(w.props('sections')).toBe(before);
    expect(w.emitted('update:sections')).toBeUndefined();
    expect(w.find('[data-test="save-error"]').text()).toContain('disk full');
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
    // The second 'c' lives in another doc: kept under a fresh id, not dropped.
    expect(titles(w).sort()).toEqual(['A', 'B', 'C', 'C again']);
    expect(w.find('[data-test="outline-repaired"]').exists()).toBe(true);
    await w.find('[data-test="section-c"]').trigger('dragstart');
    await w.find('[data-test="section-b"]').trigger('drop');
    await settle();
    const saved = w.props('sections');
    expect(saved.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'c~2']);
    expect(saved.find((s) => s.id === 'c~2')!.docId).toBe('d/c2');
    expect(saved.find((s) => s.id === 'c')!.parentId).toBe('b');
    expect(w.find('[data-test="outline-repaired"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('repair notice', () => {
  it('says the next change saves the repair', async () => {
    const outline = sampleOutline();
    // A section inside itself: needs repair on load.
    const broken = outline.map((s, i) => (i === 1 ? { ...s, parentId: s.id } : s));
    const open = setup({ sections: broken });
    expect(open.find('[data-test="outline-repaired"]').text()).toContain('Your next change saves');
    open.unmount();
  });
});
