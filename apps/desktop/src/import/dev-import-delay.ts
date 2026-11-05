export async function devImportEvidenceDelay(): Promise<void> {
  if (productionBuild()) return;
  const ms = readSlowImportMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

function productionBuild(): boolean {
  const env = (import.meta as { env?: { PROD?: boolean; MODE?: string } }).env;
  return env?.PROD === true || env?.MODE === 'production';
}

function readSlowImportMs(): number {
  try {
    const ls = (globalThis as { localStorage?: { getItem(key: string): string | null } })
      .localStorage;
    const raw = ls?.getItem('swarmdraft.slowImportMs');
    const ms = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}
