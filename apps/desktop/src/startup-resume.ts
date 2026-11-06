/** Cold-start gate: hide the import welcome until we know whether a last book will reopen (#329). */
export type StartupResumePhase = 'pending' | 'done';

export function startupResumeAfterReopen(): StartupResumePhase {
  return 'done';
}

export function shouldShowImportHome(
  phase: StartupResumePhase,
  hasSession: boolean,
  choosingBook: boolean,
  showOpeningShell: boolean,
): boolean {
  if (phase === 'pending') return false;
  return (!hasSession || choosingBook) && !showOpeningShell;
}
