import { describe, expect, it, vi } from 'vitest';
import { exportApi } from './api';
import { runBookExport } from './run-book-export';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));

describe('runBookExport (#242 toolbar path)', () => {
  it('runs Save dialog after a successful job', async () => {
    const trigger = vi.spyOn(exportApi, 'trigger').mockResolvedValue({
      id: 'j1',
      manuscriptId: 'm1',
      format: 'docx',
      trim: null,
      status: 'queued',
      filePath: null,
      errorMessage: null,
      log: null,
      createdAt: '',
      finishedAt: null,
    });
    const wait = vi.spyOn(exportApi, 'wait').mockResolvedValue({
      id: 'j1',
      manuscriptId: 'm1',
      format: 'docx',
      trim: null,
      status: 'succeeded',
      filePath: '/tmp/hidden/Book.docx',
      errorMessage: null,
      log: null,
      createdAt: '',
      finishedAt: null,
    });
    const save = vi.spyOn(exportApi, 'saveToDialog').mockResolvedValue('/home/writer/Documents/Book.docx');

    const lines: string[] = [];
    const result = await runBookExport('m1', 'docx', '', (s) => lines.push(s));

    expect(trigger).toHaveBeenCalledWith('m1', 'docx', expect.any(Object));
    expect(wait).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('j1');
    expect(result.savedPath).toBe('/home/writer/Documents/Book.docx');
    expect(result.status).toBe('Export saved.');
    trigger.mockRestore();
    wait.mockRestore();
    save.mockRestore();
  });
});
