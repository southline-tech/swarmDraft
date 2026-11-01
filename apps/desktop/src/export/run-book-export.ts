/**
 * Shared export + Save dialog flow (#242), used by toolbar and Settings export UI.
 */
import { isTauri } from '@tauri-apps/api/core';
import { exportApi, exportStatusLabel, pandocDownloadStatusLabel, type ExportFormat } from './api';
import { errorLine } from '../errors/map-error';

export type RunBookExportResult = {
  status: string;
  savedPath: string | null;
  cancelled: boolean;
};

export async function runBookExport(
  manuscriptId: string,
  format: ExportFormat,
  pandocPath: string,
  onStatus: (message: string) => void,
): Promise<RunBookExportResult> {
  if (!isTauri()) {
    return {
      status: 'Export is only available in the desktop app.',
      savedPath: null,
      cancelled: false,
    };
  }
  onStatus('');
  try {
    const job = await exportApi.trigger(manuscriptId, format, { pandocPath });
    if (!job) {
      return {
        status: 'Export is only available in the desktop app.',
        savedPath: null,
        cancelled: false,
      };
    }
    onStatus('Export started…');
    const done = await exportApi.wait(job.id, {
      deadlineMs: 600_000,
      onTick: (_j, pandoc) => {
        if (pandoc?.active) onStatus(pandocDownloadStatusLabel(pandoc));
      },
    });
    if (!done) {
      return {
        status: 'Still working… check again in a moment.',
        savedPath: null,
        cancelled: false,
      };
    }
    if (done.status === 'failed') {
      return { status: exportStatusLabel(done), savedPath: null, cancelled: false };
    }
    const saved = await exportApi.saveToDialog(done.id);
    if (saved === null) {
      return { status: 'Export cancelled.', savedPath: null, cancelled: true };
    }
    const path = saved || done.filePath;
    if (path) {
      return {
        status: exportStatusLabel({ ...done, filePath: path }),
        savedPath: path,
        cancelled: false,
      };
    }
    return { status: exportStatusLabel(done), savedPath: null, cancelled: false };
  } catch (e) {
    return { status: errorLine(e, 'export'), savedPath: null, cancelled: false };
  }
}
