import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportCancelledError } from './import-cancelled';
import { runDocxImport, setForceSyncDocxImport } from './run-docx-import';

const mockDocx = resolve(
  import.meta.dirname,
  '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);

afterEach(() => {
  setForceSyncDocxImport(import.meta.env.MODE === 'test');
});

describe('runDocxImport (#299)', () => {
  it('resolves a parsed import on the sync fallback path', async () => {
    setForceSyncDocxImport(true);
    const bytes = readFileSync(mockDocx);
    const parsed = await runDocxImport(bytes, { manuscriptId: 'm-import' }).done;
    expect(parsed.imported.title).toBeTruthy();
    expect(parsed.ydocs.sectionUpdates.size).toBeGreaterThan(0);
  });

  it('cancel rejects before the sync import finishes', async () => {
    setForceSyncDocxImport(true);
    const bytes = readFileSync(mockDocx);
    const job = runDocxImport(bytes, { manuscriptId: 'm-cancel' });
    job.abort();
    await expect(job.done).rejects.toBeInstanceOf(ImportCancelledError);
  });

  it('runs import in a worker without blocking the main thread', async () => {
    setForceSyncDocxImport(false);
    const bytes = readFileSync(mockDocx);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    try {
      const job = runDocxImport(bytes, { manuscriptId: 'm-worker' });
      await new Promise((r) => setTimeout(r, 25));
      const parsed = await job.done;
      expect(JSON.stringify(parsed.imported.sections)).toContain('Chapter');
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  }, 120_000);

  it('terminates the worker when cancelled mid-import', async () => {
    setForceSyncDocxImport(false);
    const bytes = readFileSync(mockDocx);
    const job = runDocxImport(bytes, { manuscriptId: 'm-worker-cancel' });
    job.abort();
    await expect(job.done).rejects.toBeInstanceOf(ImportCancelledError);
  });
});
