import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ExportSection from './ExportSection.vue';

describe('ExportSection', () => {
  it('prompts to open a book when no manuscript id', () => {
    const w = mount(ExportSection, { props: {} });
    expect(w.find('[data-test="export-no-book"]').exists()).toBe(true);
  });

  it('shows export actions when a book is open', () => {
    const w = mount(ExportSection, {
      props: { manuscriptId: 'm1', bookTitle: 'Demo' },
    });
    expect(w.find('[data-test="export-epub"]').exists()).toBe(true);
    expect(w.find('[data-test="export-docx"]').exists()).toBe(true);
  });
});
