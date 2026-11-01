import { invoke, isTauri } from '@tauri-apps/api/core';

/** Mirrors `export::ExportJob` in Rust. */
export interface ExportJob {
  id: string;
  manuscriptId: string;
  format: 'epub' | 'docx' | 'pdf';
  trim: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  filePath: string | null;
  errorMessage: string | null;
  log: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Mirrors `export::PandocDownloadStatus` in Rust. */
export interface PandocDownloadStatus {
  active: boolean;
  phase: string | null;
  percent: number | null;
  message: string | null;
}

export type ExportFormat = 'epub' | 'docx';

export async function triggerExport(
  manuscriptId: string,
  format: ExportFormat,
  opts: { trim?: string; pandocPath?: string } = {},
): Promise<ExportJob | null> {
  if (!isTauri()) return null;
  const pandocPath = opts.pandocPath?.trim() || null;
  return invoke<ExportJob>('export_trigger', {
    manuscriptId,
    format,
    trim: opts.trim ?? null,
    pandocPath,
  });
}

export async function getPandocDownloadStatus(): Promise<PandocDownloadStatus | null> {
  if (!isTauri()) return null;
  return invoke<PandocDownloadStatus>('pandoc_download_status');
}

export async function getExportJob(jobId: string): Promise<ExportJob | null> {
  if (!isTauri()) return null;
  return invoke<ExportJob>('export_get', { jobId });
}

export async function listExportJobs(
  manuscriptId: string,
  limit = 10,
): Promise<ExportJob[] | null> {
  if (!isTauri()) return null;
  return invoke<ExportJob[]>('export_list', { manuscriptId, limit });
}

export function pandocDownloadStatusLabel(status: PandocDownloadStatus): string {
  if (!status.active) return '';
  if (status.message) {
    if (status.percent != null && status.phase === 'downloading') {
      return `${status.message} ${status.percent}%`;
    }
    return status.message;
  }
  return 'Preparing Pandoc…';
}

/** Poll until the job leaves queued/running or `deadline` passes. */
export async function waitForExportJob(
  jobId: string,
  opts: {
    intervalMs?: number;
    deadlineMs?: number;
    onTick?: (job: ExportJob, pandoc: PandocDownloadStatus | null) => void;
  } = {},
): Promise<ExportJob | null> {
  const intervalMs = opts.intervalMs ?? 400;
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const job = await getExportJob(jobId);
    const pandoc = await getPandocDownloadStatus();
    if (job && opts.onTick) opts.onTick(job, pandoc);
    if (!job) return null;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return getExportJob(jobId);
}

export function exportStatusLabel(job: ExportJob): string {
  if (job.status === 'queued') return 'Waiting to start…';
  if (job.status === 'running') return 'Exporting…';
  if (job.status === 'succeeded')
    return job.filePath ? `Saved to ${job.filePath}` : 'Export finished.';
  return job.errorMessage ?? 'Export failed.';
}

export const exportApi = {
  trigger: triggerExport,
  get: getExportJob,
  list: listExportJobs,
  wait: waitForExportJob,
  statusLabel: exportStatusLabel,
  pandocStatus: getPandocDownloadStatus,
  pandocStatusLabel: pandocDownloadStatusLabel,
};
