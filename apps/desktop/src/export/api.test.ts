import { describe, expect, it, vi } from 'vitest';
import { exportStatusLabel } from './api';

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
        errorMessage:
          'Pandoc is not installed. Install Pandoc from https://pandoc.org/ and try again.',
        log: null,
        createdAt: 't',
        finishedAt: 't2',
      }),
    ).toContain('Pandoc');
  });
});

describe('export IPC wiring', () => {
  it('calls export_trigger with manuscript id and format', async () => {
    vi.resetModules();
    const invoke = vi.fn().mockResolvedValue({ id: 'e1', status: 'queued' });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
    const { triggerExport } = await import('./api');
    await triggerExport('ms-1', 'epub');
    expect(invoke).toHaveBeenCalledWith('export_trigger', {
      manuscriptId: 'ms-1',
      format: 'epub',
      trim: null,
    });
  });
});
