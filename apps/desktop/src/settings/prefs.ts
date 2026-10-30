/**
 * Local preferences from Settings (#99): the app theme and your name & color. Both live in
 * localStorage on this computer; a missing or broken store falls back to the defaults.
 */
import { SWATCHES } from '../shells/colors';
import { applyThemeParam } from '../shells/preview';

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'swarmdraft.theme';
export const PROFILE_KEY = 'swarmdraft.profile';
export const TRACKING_KEY = 'swarmdraft.trackChanges';
export const TRACK_PROMPT_SEEN_KEY = 'swarmdraft.trackPromptSeen';

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

/**
 * Startup (#102): apply the saved theme before the first paint, then let a `?theme=` preview
 * param override it. Called from main.ts before the app mounts.
 */
export function bootTheme(
  search: string = globalThis.location?.search ?? '',
  storage: Store = globalThis.localStorage,
  root: HTMLElement = document.documentElement,
): void {
  applyTheme(loadTheme(storage), root);
  applyThemeParam(search, root);
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
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(kept));
  } catch {
    // Storage unavailable: caller still gets the normalized profile for this session.
  }
  return kept;
}

export function hasStoredProfile(storage: Store = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(PROFILE_KEY) != null;
  } catch {
    return false;
  }
}

export function loadTracking(storage: Store = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(TRACKING_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveTracking(on: boolean, storage: Store = globalThis.localStorage): void {
  try {
    storage?.setItem(TRACKING_KEY, on ? '1' : '0');
  } catch {
    // Session-only when storage is unavailable.
  }
}

export function loadTrackPromptSeen(storage: Store = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(TRACK_PROMPT_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveTrackPromptSeen(storage: Store = globalThis.localStorage): void {
  try {
    storage?.setItem(TRACK_PROMPT_SEEN_KEY, '1');
  } catch {
    // Session-only when storage is unavailable.
  }
}

/** Trim and cap a writer display name for profile seeding (#57). */
export function normalizeWriterName(raw: string, fallback = DEFAULT_PROFILE.name): string {
  const name = raw.trim().slice(0, 64);
  return name || fallback;
}

/** Best-effort computer display name when seeding profile (no OS IPC in #57). */
export function computerDisplayName(override?: string, fallback = DEFAULT_PROFILE.name): string {
  if (override?.trim()) return normalizeWriterName(override, fallback);
  return fallback;
}

/** Seed profile on first track-changes enable when nothing is stored yet. */
export function seedProfileForTracking(
  computerName: string | undefined,
  storage: Store = globalThis.localStorage,
): Profile {
  if (hasStoredProfile(storage)) return loadProfile(storage);
  return saveProfile(
    { name: computerDisplayName(computerName), color: DEFAULT_PROFILE.color },
    storage,
  );
}

export const SPELL_PREFS_KEY = 'swarmdraft.spellPrefs';

export interface SpellPrefs {
  spelling: boolean;
  grammar: boolean;
}

export const DEFAULT_SPELL_PREFS: Readonly<SpellPrefs> = { spelling: true, grammar: true };

export function loadSpellPrefs(storage: Store = globalThis.localStorage): SpellPrefs {
  try {
    const raw = storage?.getItem(SPELL_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SPELL_PREFS };
    const p = JSON.parse(raw) as Partial<SpellPrefs>;
    return {
      spelling: p.spelling !== false,
      grammar: p.grammar !== false,
    };
  } catch {
    return { ...DEFAULT_SPELL_PREFS };
  }
}

export function saveSpellPrefs(
  p: SpellPrefs,
  storage: Store = globalThis.localStorage,
): SpellPrefs {
  const kept: SpellPrefs = {
    spelling: p.spelling !== false,
    grammar: p.grammar !== false,
  };
  try {
    storage?.setItem(SPELL_PREFS_KEY, JSON.stringify(kept));
  } catch {
    // Session-only when storage is unavailable.
  }
  try {
    globalThis.dispatchEvent(new Event('swarmdraft-spell-prefs'));
  } catch {
    // Non-browser tests.
  }
  return kept;
}

export function spellcheckEnabled(p: SpellPrefs = loadSpellPrefs()): boolean {
  return p.spelling || p.grammar;
}
