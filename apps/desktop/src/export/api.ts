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

export type ExportFormat = 'epub' | 'docx';

export async function triggerExport(
  manuscriptId: string,
  format: ExportFormat,
  trim?: string,
): Promise<ExportJob | null> {
  if (!isTauri()) return null;
  return invoke<ExportJob>('export_trigger', { manuscriptId, format, trim: trim ?? null });
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

/** Poll until the job leaves queued/running or `deadline` passes. */
export async function waitForExportJob(
  jobId: string,
  opts: { intervalMs?: number; deadlineMs?: number } = {},
): Promise<ExportJob | null> {
  const intervalMs = opts.intervalMs ?? 400;
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const job = await getExportJob(jobId);
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
};
