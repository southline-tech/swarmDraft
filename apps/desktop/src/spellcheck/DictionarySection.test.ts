import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import DictionarySection from './DictionarySection.vue';
import { SPELL_PREFS_KEY } from '../settings/prefs';

vi.mock('../backend', () => ({
  spellDictionaryList: vi.fn(),
  spellDictionaryAdd: vi.fn(),
  spellDictionaryRemove: vi.fn(),
}));

import { spellDictionaryAdd, spellDictionaryList, spellDictionaryRemove } from '../backend';

enableAutoUnmount(afterEach);

beforeEach(() => {
  localStorage.removeItem(SPELL_PREFS_KEY);
  vi.mocked(spellDictionaryList).mockReset();
  vi.mocked(spellDictionaryAdd).mockReset();
  vi.mocked(spellDictionaryRemove).mockReset();
});

describe('DictionarySection (#159)', () => {
  it('shows mockup intro and toggle helper copy', () => {
    vi.mocked(spellDictionaryList).mockResolvedValue([]);
    const w = mount(DictionarySection, {
      props: { manuscriptId: 'book-1', backendAvailable: true },
    });
    const text = w.get('[data-test=settings-spelling]').text();
    expect(text).toContain('Check this manuscript as you write');
    expect(text).toContain("Red wavy underline on words that aren't in the dictionary");
    expect(text).toContain('Green wavy underline on grammar issues');
  });

  it('shows sc5 empty dictionary copy before the add-word field', async () => {
    vi.mocked(spellDictionaryList).mockResolvedValue([]);
    const w = mount(DictionarySection, {
      props: { manuscriptId: 'book-1', backendAvailable: true },
    });
    await flushPromises();
    expect(w.get('[data-test=dict-empty]').text()).toContain(
      "No words in this manuscript's dictionary yet",
    );
    expect(w.find('[data-test=dict-list]').exists()).toBe(false);
  });

  it('labels each Remove control with the word', async () => {
    vi.mocked(spellDictionaryList).mockResolvedValue(['Harborwick', 'foghorn']);
    const w = mount(DictionarySection, {
      props: { manuscriptId: 'book-1', backendAvailable: true },
    });
    await flushPromises();
    expect(w.get('[data-test=dict-remove-Harborwick]').attributes('aria-label')).toBe(
      'Remove Harborwick',
    );
    expect(w.get('[data-test=dict-remove-foghorn]').attributes('aria-label')).toBe(
      'Remove foghorn',
    );
  });

  it('loads and removes dictionary words through the backend', async () => {
    vi.mocked(spellDictionaryList).mockResolvedValueOnce(['alpha']).mockResolvedValueOnce([]);
    vi.mocked(spellDictionaryRemove).mockResolvedValue(undefined);
    const w = mount(DictionarySection, {
      props: { manuscriptId: 'book-1', backendAvailable: true },
    });
    await flushPromises();
    await w.get('[data-test=dict-remove-alpha]').trigger('click');
    await flushPromises();
    expect(spellDictionaryRemove).toHaveBeenCalledWith('book-1', 'alpha');
    expect(spellDictionaryAdd).not.toHaveBeenCalled();
  });
});
