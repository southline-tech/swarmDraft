import { describe, expect, it, vi } from 'vitest';
import { exportStatusLabel, pandocDownloadStatusLabel } from './api';

describe('exportStatusLabel', () => {
  it('maps failed jobs to the backend error message', () => {
    expect(
      exportStatusLabel({
        id: 'j1',
        manuscriptId: 'm1',
        format: 'docx',
        trim: null,
        status: 'failed',
        filePath: null,
        errorMessage: 'pandoc: offline: could not download Pandoc. Try again when online.',
        log: null,
        createdAt: 't',
        finishedAt: 't2',
      }),
    ).toContain('offline');
  });
});

describe('pandocDownloadStatusLabel', () => {
  it('includes percent while downloading', () => {
    expect(
      pandocDownloadStatusLabel({
        active: true,
        phase: 'downloading',
        percent: 42,
        message: 'Downloading Pandoc…',
      }),
    ).toBe('Downloading Pandoc… 42%');
  });
});

describe('export IPC wiring', () => {
  it('calls export_trigger with manuscript id, format, and pandoc path', async () => {
    vi.resetModules();
    const invoke = vi.fn().mockResolvedValue({ id: 'e1', status: 'queued' });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
    const { triggerExport } = await import('./api');
    await triggerExport('ms-1', 'epub', { pandocPath: 'C:\\Tools\\pandoc.exe' });
    expect(invoke).toHaveBeenCalledWith('export_trigger', {
      manuscriptId: 'ms-1',
      format: 'epub',
      trim: null,
      pandocPath: 'C:\\Tools\\pandoc.exe',
    });
  });
});
