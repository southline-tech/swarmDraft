import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PROFILE, PROFILE_KEY, THEME_KEY, bootTheme, loadProfile } from './prefs';

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
