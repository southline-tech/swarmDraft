import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { exportJobPathLabel, exportStatusLabel } from './api';
import ExportSection from './ExportSection.vue';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

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
    expect(w.find('[data-test="export-pandoc-path"]').exists()).toBe(true);
  });

  it('shows saved path once in recent exports, not in the status line (#242)', () => {
    expect(
      exportStatusLabel({
        id: 'j1',
        manuscriptId: 'm1',
        format: 'docx',
        trim: null,
        status: 'succeeded',
        filePath: '/home/writer/Documents/Book.docx',
        errorMessage: null,
        log: null,
        createdAt: '',
        finishedAt: null,
      }),
    ).toBe('Export saved.');
    expect(
      exportJobPathLabel({
        id: 'j1',
        manuscriptId: 'm1',
        format: 'docx',
        trim: null,
        status: 'succeeded',
        filePath: '/home/writer/Documents/Book.docx',
        errorMessage: null,
        log: null,
        createdAt: '',
        finishedAt: null,
      }),
    ).toContain('Book.docx');
  });
});
