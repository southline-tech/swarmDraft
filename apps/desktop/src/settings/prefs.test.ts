import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_PROFILE,
  PROFILE_KEY,
  THEME_KEY,
  TRACKING_KEY,
  TRACK_PROMPT_SEEN_KEY,
  bootTheme,
  loadProfile,
  loadTracking,
  saveProfile,
  seedProfileForTracking,
} from './prefs';

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe('bootTheme (#102)', () => {
  it('a stored "dark" sets <html data-theme="dark"> at startup', () => {
    const root = document.createElement('html');
    bootTheme('', store({ [THEME_KEY]: 'dark' }), root);
    expect(root.dataset.theme).toBe('dark');
  });

  it('?theme=light still overrides a stored "dark"', () => {
    const root = document.createElement('html');
    bootTheme('?theme=light', store({ [THEME_KEY]: 'dark' }), root);
    expect(root.dataset.theme).toBe('light');
  });

  it('main.ts boots the theme through bootTheme() before mounting', () => {
    const src = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');
    expect(src).toMatch(/bootTheme\(\);[\s\S]*createApp\(App\)\.mount/);
  });
});

describe('loadProfile (#102)', () => {
  it('a non-string name and an unknown color fall back to the defaults', () => {
    const s = store({ [PROFILE_KEY]: JSON.stringify({ name: { x: 1 }, color: 999 }) });
    expect(loadProfile(s)).toEqual(DEFAULT_PROFILE);
  });
});

describe('track changes prefs (#57)', () => {
  it('loadTracking reads stored on/off', () => {
    const s = store({ [TRACKING_KEY]: '1' });
    expect(loadTracking(s)).toBe(true);
    expect(loadTracking(store())).toBe(false);
  });

  it('seedProfileForTracking writes once and respects an existing profile', () => {
    const s = store();
    expect(seedProfileForTracking('Ada', s)).toEqual({ name: 'Ada', color: DEFAULT_PROFILE.color });
    expect(s.getItem(PROFILE_KEY)).toBeTruthy();
    saveProfile({ name: 'Custom', color: 4 }, s);
    expect(seedProfileForTracking('Ignored', s)).toEqual({ name: 'Custom', color: 4 });
  });

  it('track prompt seen flag persists', () => {
    const s = store();
    expect(s.getItem(TRACK_PROMPT_SEEN_KEY)).toBeNull();
    s.setItem(TRACK_PROMPT_SEEN_KEY, '1');
    expect(s.getItem(TRACK_PROMPT_SEEN_KEY)).toBe('1');
  });
});
