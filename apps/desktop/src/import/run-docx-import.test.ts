import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportCancelledError } from './import-cancelled';
import { runDocxImport, setForceSyncDocxImport } from './run-docx-import';

const mockDocx = resolve(
  import.meta.dirname,
  '../../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);

const largeSyntheticDocx = resolve(
  import.meta.dirname,
  '../../../../fixtures/manuscripts/large-synthetic/large-synthetic.docx',
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

  it('imports large synthetic docx in worker while main thread keeps ticking', async () => {
    setForceSyncDocxImport(false);
    const bytes = readFileSync(largeSyntheticDocx);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    const started = performance.now();
    try {
      const job = runDocxImport(bytes, { manuscriptId: 'm-large' });
      await new Promise((r) => setTimeout(r, 25));
      const parsed = await job.done;
      const elapsedMs = Math.round(performance.now() - started);
      expect(parsed.imported.sections.length).toBeGreaterThanOrEqual(350);
      expect(parsed.ydocs.sectionUpdates.size).toBeGreaterThanOrEqual(350);
      expect(ticks).toBeGreaterThan(0);
      expect(elapsedMs).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  }, 180_000);
});
