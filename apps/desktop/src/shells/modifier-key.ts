/** True on macOS (and iOS). Command vs Control shortcuts (#193). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.platform ?? '';
  if (/Mac|iPhone|iPod|iPad/.test(p)) return true;
  return (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ===
    'macOS'
  );
}

type ModifierEvent = { ctrlKey: boolean; metaKey: boolean };

/**
 * Primary shortcut modifier: Command on macOS, Control elsewhere.
 * The other modifier does not count, so Control+S on a Mac is not a Command chord.
 */
export function usesPrimaryModifier(e: ModifierEvent): boolean {
  return isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
