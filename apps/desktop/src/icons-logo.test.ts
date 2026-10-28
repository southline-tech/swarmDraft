import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppLogo from './AppLogo.vue';
import logoUrl from './assets/logo/coauthor-c-caret.svg';
import logo24Url from './assets/logo/coauthor-c-caret-24.png';
import logo48Url from './assets/logo/coauthor-c-caret-48.png';
import HomeScreen from './HomeScreen.vue';
import SectionNav from './SectionNav.vue';
import AppIcon from './icons/AppIcon.vue';
import { ICONS } from './icons/icons';
import { SAMPLE_MANUSCRIPT_ID, sampleOutline } from './fixtures/outline-sample';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const styles = (sfc: string) =>
  [...sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const defined = new Set(
  [...read('./styles/tokens.css').matchAll(/(--ct-[\w-]+)\s*:/g)].map((m) => m[1]),
);

// Components swept to tokens in this PR (#37 / #47).
const SWEPT = [
  './App.vue',
  './HomeScreen.vue',
  './SectionNav.vue',
  './AgentsSettings.vue',
  './ManuscriptEditor.vue',
  './comments/CommentsPanel.vue',
  './AppLogo.vue',
  './icons/AppIcon.vue',
  './settings/SettingsScreen.vue',
  './settings/NameColorSection.vue',
  './settings/BackupsSection.vue',
];

describe('design tokens only', () => {
  it.each(SWEPT)('%s styles use no hard-coded colors or fonts', (file) => {
    const css = styles(read(file));
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(css).not.toMatch(/\b(Georgia|system-ui)\b/);
  });

  it.each(SWEPT)('%s only uses --ct-* variables that exist', (file) => {
    const used = [...styles(read(file)).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? '');
    expect(used.filter((v) => !v.startsWith('--ct-') || !defined.has(v))).toEqual([]);
  });

  it('selected outline row uses the theme selection token (readable in dark)', () => {
    const rule = styles(read('./SectionNav.vue')).match(/\.row\.selected\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('var(--ct-selected-bg)');
    expect(rule).toContain('var(--ct-text)');
  });
});

it('settings.css (#99) uses only --ct-* tokens that exist and no hard-coded colors', () => {
  const css = read('./settings/settings.css');
  expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? '');
  expect(used.filter((v) => !v.startsWith('--ct-') || !defined.has(v))).toEqual([]);
});

describe('logo', () => {
  it('uses the caret SVG at 48px and up and the 24px PNG with a 48px 2x srcset below', () => {
    const big = mount(AppLogo, { props: { size: 64 } }).get('img');
    const small = mount(AppLogo, { props: { size: 24 } }).get('img');
    expect(big.attributes('src')).toBe(logoUrl);
    expect(big.attributes('srcset')).toBeUndefined();
    expect(small.attributes('src')).toBe(logo24Url);
    expect(small.attributes('srcset')).toBe(`${logo24Url} 1x, ${logo48Url} 2x`);
    expect(logo24Url).not.toBe(logo48Url);
    expect(small.attributes('width')).toBe('24');
    expect(big.attributes('alt')).toBe('');
  });

  it('defaults to the 64px caret SVG when no size is given', () => {
    const img = mount(AppLogo).get('img');
    expect(img.attributes('width')).toBe('64');
    expect(img.attributes('height')).toBe('64');
    expect(img.attributes('src')).toBe(logoUrl);
    expect(img.attributes('srcset')).toBeUndefined();
  });

  it('welcome screen shows the logo, not a text placeholder', () => {
    const w = mount(HomeScreen, { props: { step: 'welcome' } as never });
    expect(w.find('[data-test="home-welcome"] img[data-test="app-logo"]').exists()).toBe(true);
    expect(w.find('[data-test="home-welcome"] div.home__mark').exists()).toBe(false);
  });

  it('title bar shows the small logo next to the name', () => {
    const src = read('./App.vue');
    expect(src).toMatch(
      /<header[^>]*class="topbar"[^>]*>[\s\S]*<AppLogo :size="24" \/>[\s\S]*<\/header>/,
    );
  });
});

describe('icon set', () => {
  it('renders every icon on the shared 16px grid', () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const svg = mount(AppIcon, { props: { name } }).get('svg');
      expect(svg.attributes('viewBox')).toBe('0 0 16 16');
      expect(svg.attributes('aria-hidden')).toBe('true');
      expect(svg.findAll('path').length).toBe(ICONS[name].length);
    }
  });

  it('outline move buttons are labelled icon buttons, not arrow characters', () => {
    const w = mount(SectionNav, {
      props: {
        manuscriptId: SAMPLE_MANUSCRIPT_ID,
        sections: sampleOutline(),
        selectedId: sampleOutline()[1]!.id,
      },
    });
    for (const [t, label, icon] of [
      ['move-up', 'Move up', 'arrow-up'],
      ['move-down', 'Move down', 'arrow-down'],
    ]) {
      const b = w.get(`[data-test="${t}"]`);
      expect(b.attributes('aria-label')).toBe(label);
      expect(b.attributes('title')).toBe(label);
      expect(b.find(`svg[data-icon="${icon}"]`).exists()).toBe(true);
      expect(b.text()).not.toMatch(/[↑↓]/);
    }
    expect(
      w.findAll('[aria-label="Add section"] button svg[data-icon="plus"]').length,
    ).toBeGreaterThan(0);
  });
});
