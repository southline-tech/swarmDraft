import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { sectionNumberLabels } from '@swarmdraft/editor';
import type { Section } from '@swarmdraft/schema';
import SectionNav from './SectionNav.vue';
import SettingsScreen from './settings/SettingsScreen.vue';
import { sessionFromStored } from './manuscript-session';
import { storedFixture } from './stored-fixture.test-helper';

const outline: Section[] = [
  { id: 'p1', kind: 'part', title: 'The Bell That Stopped', docId: 'd-p' },
  { id: 'c1', kind: 'chapter', title: 'Low Tide', parentId: 'p1', docId: 'd-c1' },
  { id: 'c2', kind: 'chapter', title: 'Stillwater', parentId: 'p1', docId: 'd-c2' },
];

describe('numbering UI (#111)', () => {
  it('recomputes part and chapter labels when the style changes', () => {
    const arabic = sectionNumberLabels(outline, 'chapter_arabic');
    expect(arabic.get('p1')).toBe('Part I');
    expect(arabic.get('c1')).toBe('Chapter 1');
    expect(arabic.get('c2')).toBe('Chapter 2');

    const words = sectionNumberLabels(outline, 'chapter_words');
    expect(words.get('p1')).toBe('Part One');
    expect(words.get('c1')).toBe('Chapter One');
    expect(words.get('c2')).toBe('Chapter Two');
  });

  it('SectionNav emits numberingStyle when the outline picker changes', async () => {
    const w = mount(SectionNav, {
      props: {
        manuscriptId: 'm1',
        sections: outline,
        numberingStyle: 'chapter_arabic',
      },
      attachTo: document.body,
    });
    await w.get('[data-test="outline-numbering-select"]').setValue('chapter_words');
    expect(w.emitted('numberingStyle')).toEqual([['chapter_words']]);
    w.unmount();
  });

  it('Settings emits numberingStyle when the book-wide picker changes', async () => {
    const w = mount(SettingsScreen, {
      attachTo: document.body,
      props: {
        info: { version: '0', dataDir: '/tmp', schemaVersion: 1 },
        backupStatus: '',
        confirmingRestore: false,
        tokensNotice: null,
        bookOpen: true,
        numberingStyle: 'chapter_arabic',
      },
      global: { stubs: { AgentsSettings: { template: '<div />' } } },
    });
    await w.get('[data-test="numbering-style-select"]').setValue('number_only');
    expect(w.emitted('numberingStyle')).toEqual([['number_only']]);
    w.unmount();
  });

  it('session setNumberingStyle updates reactive labels', async () => {
    const stored = storedFixture();
    const saveStyle = vi.fn(async () => {});
    const s = sessionFromStored(
      stored,
      null,
      { save: async () => {} },
      async () => {},
      undefined,
      saveStyle,
    );
    const before = sectionNumberLabels(s.outline.value, s.numberingStyle.value);
    expect(before.get(s.outline.value.find((x) => x.kind === 'part')!.id)).toBe('Part I');
    await s.setNumberingStyle('chapter_words');
    await flushPromises();
    const after = sectionNumberLabels(s.outline.value, s.numberingStyle.value);
    expect(after.get(s.outline.value.find((x) => x.kind === 'part')!.id)).toBe('Part One');
    expect(saveStyle).toHaveBeenCalledWith('chapter_words');
    await s.close();
  });
});
