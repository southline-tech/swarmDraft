import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Section } from '@coauthor/schema';
import SectionNav from './SectionNav.vue';
import { SAMPLE_MANUSCRIPT_ID, sampleOutline } from './outline-sample';

function setup(selectedId?: string) {
  const w = mount(SectionNav, {
    props: {
      manuscriptId: SAMPLE_MANUSCRIPT_ID,
      sections: sampleOutline(),
      ...(selectedId ? { selectedId } : {}),
      'onUpdate:sections': (s: Section[]) => w.setProps({ sections: s }),
      onSelect: (id: string) => w.setProps({ selectedId: id }),
    },
    attachTo: document.body,
  });
  return w;
}
const titles = (w: ReturnType<typeof setup>) => w.findAll('.row .title').map((r) => r.text());

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
  });

  it('selects, adds a scene into the selected chapter and renames it', async () => {
    const w = setup();
    await w.find('[data-test="section-ch-2"]').trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['ch-2']);
    await w.find('[data-test="add-scene"]').trigger('click');
    const s = w.props('sections');
    const added = s[s.length - 2]!;
    expect(added).toMatchObject({ kind: 'scene', parentId: 'ch-2' });
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Harbor at dusk');
    await input.trigger('keydown', { key: 'Enter' });
    expect(titles(w)).toContain('Harbor at dusk');
  });

  it('reorders with the arrow buttons', async () => {
    const w = setup('sc-2');
    await w.find('[data-test="move-up"]').trigger('click');
    expect(titles(w).slice(3, 5)).toEqual(['Scene 2', 'Scene 1']);
  });

  it('drags a scene into another chapter', async () => {
    const w = setup();
    await w.find('[data-test="section-sc-1"]').trigger('dragstart');
    await w.find('[data-test="section-ch-2"]').trigger('drop');
    const moved = w.props('sections').find((x) => x.id === 'sc-1')!;
    expect(moved.parentId).toBe('ch-2');
    expect(titles(w).slice(2, 6)).toEqual(['Chapter 1', 'Scene 2', 'Chapter 2', 'Scene 1']);
  });
});
