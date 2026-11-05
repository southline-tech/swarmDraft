import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import * as backend from './backend';
import { storedFixture } from './stored-fixture.test-helper';
import * as runImport from './import/run-docx-import';
import { setForceSyncDocxImport } from './import/run-docx-import';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockDocx = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx'),
);

function bytes() {
  return new Uint8Array(mockDocx);
}

async function settle() {
  await flushPromises();
  await flushPromises();
}

async function chooseFile(w: ReturnType<typeof mount>) {
  const input = w.get('[data-test="open-docx"]').element as HTMLInputElement;
  const file = new File([bytes()], 'sample.docx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
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

describe('import progress (#299)', () => {
  it('cancel returns to the home screen without opening a book', async () => {
    localStorage.setItem('swarmdraft.welcomed', '1');
    const abort = vi.fn();
    vi.spyOn(runImport, 'runDocxImport').mockReturnValue({
      abort,
      done: new Promise(() => {}),
    });
    const w = mount(App, { attachTo: document.body });
    await settle();
    await chooseFile(w);
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(true);
    await w.get('[data-test="opening-cancel"]').trigger('click');
    await settle();
    expect(abort).toHaveBeenCalled();
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(false);
    expect(w.find('[data-test="home-open"]').exists()).toBe(true);
    expect(w.findAll('.row')).toHaveLength(0);
    w.unmount();
  });
});
