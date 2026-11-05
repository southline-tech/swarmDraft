import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportCancelledError } from './import-cancelled';
import { setForceSyncDocxImport } from './run-docx-import';
import { importAndOpen } from '../manuscript-session';

const mockDocx = readFileSync(
  resolve(import.meta.dirname, '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx'),
);

afterEach(() => {
  setForceSyncDocxImport(import.meta.env.MODE === 'test');
});

describe('importAndOpen cancel (#299)', () => {
  it('does not close the current session when the import signal is already aborted', async () => {
    setForceSyncDocxImport(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const current = { close, closed: false, resumeLive: vi.fn() };
    const ac = new AbortController();
    ac.abort();
    await expect(
      importAndOpen(new Uint8Array(mockDocx), {}, current as never, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(ImportCancelledError);
    expect(close).not.toHaveBeenCalled();
  });
});
