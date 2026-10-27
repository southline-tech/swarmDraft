/** "Open previews" (UI shells) is for test and dev builds only (#99 PM decision). */
export function previewsEnabled(env: { DEV?: boolean; MODE?: string } = import.meta.env): boolean {
  return env.DEV === true || env.MODE === 'test';
}
