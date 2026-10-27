/**
 * Local preferences from Settings (#99): the app theme and your name & color. Both live in
 * localStorage on this computer; a missing or broken store falls back to the defaults.
 */
import { SWATCHES } from '../shells/colors';

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'swarmdraft.theme';
export const PROFILE_KEY = 'swarmdraft.profile';

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined;

export function loadTheme(storage: Store = globalThis.localStorage): Theme {
  try {
    return storage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
}

export function saveTheme(theme: Theme, storage: Store = globalThis.localStorage): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the theme still applies for this session.
  }
}

export interface Profile {
  name: string;
  color: number;
}
export const DEFAULT_PROFILE: Readonly<Profile> = { name: 'Author', color: 3 };

const validColor = (c: unknown): c is number => SWATCHES.some((s) => s.id === c);

export function loadProfile(storage: Store = globalThis.localStorage): Profile {
  try {
    const raw = storage?.getItem(PROFILE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const p = JSON.parse(raw) as Partial<Profile>;
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 64) : '';
    return {
      name: name || DEFAULT_PROFILE.name,
      color: validColor(p.color) ? p.color : DEFAULT_PROFILE.color,
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** Saves a trimmed name (blank falls back to the default) and a known swatch; returns what was kept. */
export function saveProfile(p: Profile, storage: Store = globalThis.localStorage): Profile {
  const kept: Profile = {
    name: p.name.trim().slice(0, 64) || DEFAULT_PROFILE.name,
    color: validColor(p.color) ? p.color : DEFAULT_PROFILE.color,
  };
  storage?.setItem(PROFILE_KEY, JSON.stringify(kept));
  return kept;
}
