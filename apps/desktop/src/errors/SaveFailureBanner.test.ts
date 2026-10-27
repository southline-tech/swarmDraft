import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SaveFailureBanner from './SaveFailureBanner.vue';
import { mapError, saveFailed, SAVE_OK } from './map-error';
import type { SaveCopyResult } from './save-copy';

const failing = saveFailed(SAVE_OK, new Error('io: database is locked C:\\Users\\x\\coauthor.db'));
const mountWith = (saveCopy: () => Promise<SaveCopyResult>, state = failing) =>
  mount(SaveFailureBanner, { props: { state, saveCopy } });

describe('SaveFailureBanner', () => {
  it('shows the plain save-failed copy and a Save a copy button, never raw error text', () => {
    const w = mountWith(async () => ({ status: 'cancelled' }));
    expect(w.attributes('role')).toBe('alert');
    expect(w.find('[data-test="save-failure-title"]').text()).toBe(
      "Your latest changes aren't saved yet",
    );
    expect(w.find('[data-test="save-copy"]').text()).toBe('Save a copy');
    expect(w.text()).not.toMatch(/database is locked|coauthor\.db|io:/);
  });

  it('renders nothing once saves succeed', () => {
    const w = mountWith(async () => ({ status: 'cancelled' }), { ...SAVE_OK });
    expect(w.find('[data-test="save-failure"]').exists()).toBe(false);
  });

  it('Save a copy runs the save and reports where the copy went', async () => {
    const save = vi.fn(async (): Promise<SaveCopyResult> => ({
      status: 'saved',
      path: 'D:\\b.docx',
    }));
    const w = mountWith(save);
    await w.find('[data-test="save-copy"]').trigger('click');
    await flushPromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="save-copy-result"]').text()).toBe('Copy saved to D:\\b.docx.');
  });

  it('reports a failed copy with mapped copy', async () => {
    const w = mountWith(async () => ({
      status: 'failed',
      error: mapError('os error 112', 'save'),
    }));
    await w.find('[data-test="save-copy"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="save-copy-result"]').text()).toContain(
      'Your computer is almost full',
    );
    expect(w.text()).not.toContain('os error');
  });

  it('ignores a second click while a copy is being saved', async () => {
    let done!: (r: SaveCopyResult) => void;
    const save = vi.fn(() => new Promise<SaveCopyResult>((r) => (done = r)));
    const w = mountWith(save);
    await w.find('[data-test="save-copy"]').trigger('click');
    await w.find('[data-test="save-copy"]').trigger('click');
    expect(save).toHaveBeenCalledTimes(1);
    done({ status: 'cancelled' });
    await flushPromises();
  });
});
