import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import * as backend from './backend';
import { storedFixture } from './stored-fixture.test-helper';
import * as runImport from './import/run-docx-import';
import { setForceSyncDocxImport } from './import/run-docx-import';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionFromDocx } from './manuscript-session';

const mockDocx = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx'),
);

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function settle() {
  await flushPromises();
  await flushPromises();
  await frame();
}

async function chooseFile(w: ReturnType<typeof mount>) {
  const bytes = new Uint8Array(mockDocx);
  const input = w.get('[data-test="open-docx"]').element as HTMLInputElement;
  const file = new File([bytes], 'sample.docx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return settle();
}

vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof backend>();
  return {
    ...actual,
    persistImport: vi.fn(async () => storedFixture()),
    listenOpeningProgress: vi.fn(async () => () => {}),
  };
});

afterEach(() => {
  setForceSyncDocxImport(import.meta.env.MODE === 'test');
  vi.clearAllMocks();
});

describe('import error overlay (#311)', () => {
  it('shows ErrorCard over an open book instead of the open-error strip', async () => {
    let rejectDone!: (err: Error) => void;
    const done = new Promise<never>((_, reject) => {
      rejectDone = reject;
    });
    vi.spyOn(runImport, 'runDocxImport').mockReturnValueOnce({
      abort: vi.fn(),
      done,
    });
    const w = mount(App, { attachTo: document.body });
    await settle();
    (w.vm as unknown as { open: (s: ReturnType<typeof sessionFromDocx>) => void }).open(
      sessionFromDocx(new Uint8Array(mockDocx), 'open-book'),
    );
    await settle();
    const picked = chooseFile(w);
    rejectDone(new Error('truncated zip'));
    await picked;
    await settle();
    expect(w.find('[data-test="opening-error"]').exists()).toBe(true);
    expect(w.find('[data-test="open-error"]').exists()).toBe(false);
    w.unmount();
  });

  it('maps a non-Word import failure to the Word-manuscript message (#311 C2)', async () => {
    let rejectDone!: (err: Error) => void;
    const done = new Promise<never>((_, reject) => {
      rejectDone = reject;
    });
    vi.spyOn(runImport, 'runDocxImport').mockReturnValueOnce({
      abort: vi.fn(),
      done,
    });
    localStorage.setItem('swarmdraft.welcomed', '1');
    const w = mount(App, { attachTo: document.body });
    await settle();
    const picked = chooseFile(w);
    rejectDone(new Error('Not a valid .docx (zip directory not found)'));
    await picked;
    await settle();
    expect(w.find('[data-test="opening-error"]').text()).toContain(
      'can import Word manuscripts. Try choosing a different file.',
    );
    expect(w.find('[data-test="opening-error"]').text()).not.toMatch(/\.docx/);
    w.unmount();
  });

  it('calls abort once when Esc cancels import progress', async () => {
    const abort = vi.fn();
    vi.spyOn(runImport, 'runDocxImport').mockReturnValue({ abort, done: new Promise(() => {}) });
    localStorage.setItem('swarmdraft.welcomed', '1');
    const w = mount(App, { attachTo: document.body });
    await settle();
    await chooseFile(w);
    await settle();
    await w.get('[data-test="opening-progress"]').trigger('keydown', { key: 'Escape' });
    expect(abort).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
