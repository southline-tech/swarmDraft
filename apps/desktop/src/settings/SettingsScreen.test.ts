import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import SettingsScreen from './SettingsScreen.vue';
import NameColorSection from './NameColorSection.vue';
import logo24Url from '../assets/logo/swarmdraft-icon-24.png';
import { loadProfile, loadTheme, PROFILE_KEY, THEME_KEY } from './prefs';
import { previewsEnabled } from './previews';

enableAutoUnmount(afterEach);

const INFO = { version: '0.0.0-test', dataDir: '/tmp/synthetic-data', schemaVersion: 1 };
function screen(props: Record<string, unknown> = {}) {
  return mount(SettingsScreen, {
    attachTo: document.body,
    props: {
      info: INFO,
      backupStatus: '',
      confirmingRestore: false,
      tokensNotice: null,
      ...props,
    },
    global: { stubs: { AgentsSettings: { template: '<div data-test="agents-stub" />' } } },
  });
}

beforeEach(() => {
  localStorage.removeItem(THEME_KEY);
  localStorage.removeItem(PROFILE_KEY);
  delete document.documentElement.dataset.theme;
});

describe('Settings screen (#99)', () => {
  it('has the seven sections in order, one shown at a time', async () => {
    const w = screen();
    const nav = w.findAll('[data-test="settings-nav"] button').map((b) => b.text());
    expect(nav).toEqual([
      'General',
      'Your name & color',
      'Appearance',
      'Spelling & grammar',
      'Export',
      'Backups',
      'Agents',
    ]);
    expect(w.get('[data-test="settings-general"]').isVisible()).toBe(true);
    expect(w.get('[data-test="settings-backups"]').isVisible()).toBe(false);
    await w.get('[data-test="settings-nav-backups"]').trigger('click');
    expect(w.get('[data-test="settings-backups"]').isVisible()).toBe(true);
    expect(w.get('[data-test="settings-general"]').isVisible()).toBe(false);
    expect(w.get('[data-test="settings-nav-backups"]').attributes('aria-current')).toBe('page');
  });

  it('nav is 240px wide and the title bar uses AppLogo with the small mark', () => {
    const sfc = readFileSync(resolve(__dirname, 'SettingsScreen.vue'), 'utf8');
    expect(sfc).toMatch(/\.st__nav \{[^}]*width: 240px;/);
    expect(screen().get('[data-test="settings-logo"]').attributes('src')).toBe(logo24Url);
    expect(sfc).toContain('<AppLogo :size="18"');
  });

  it('General shows the page size read-only and the About rows', () => {
    const w = screen();
    expect(w.get('[data-test="default-trim"]').text()).toBe('6 × 9 in');
    expect(w.find('[data-test="settings-general"] input').exists()).toBe(false);
    const about = w.get('[data-test="app-info"]').text();
    expect(about).toContain('0.0.0-test');
    expect(about).toContain('/tmp/synthetic-data');
    expect(w.find('[data-test="browser-mode"]').exists()).toBe(false);
  });

  it('browser mode replaces About, Backups and Agents with the banner', () => {
    const w = screen({ info: null });
    expect(w.find('[data-test="app-info"]').exists()).toBe(false);
    expect(w.get('[data-test="browser-mode"]').text()).toContain(
      'Running in browser mode (no desktop backend).',
    );
    expect(w.find('[data-test="backup"]').exists()).toBe(false);
    expect(w.find('[data-test="agents-stub"]').exists()).toBe(false);
    expect(w.get('[data-test="settings-backups"]').text()).toContain('need the desktop app');
  });

  it('Open previews only exists in test or dev builds', () => {
    expect(previewsEnabled({ DEV: false, MODE: 'production' })).toBe(false);
    expect(previewsEnabled({ DEV: true, MODE: 'development' })).toBe(true);
    expect(previewsEnabled({ DEV: false, MODE: 'test' })).toBe(true);
    const w = screen();
    expect(w.find('[data-test="open-previews"]').exists()).toBe(true);
  });

  it('Theme: Light/Dark radiogroup sets data-theme on <html> and is remembered', async () => {
    const w = screen();
    const group = w.get('[role="radiogroup"][aria-label="Theme"]');
    expect(w.get('[data-test="theme-light"]').attributes('aria-checked')).toBe('true');
    await w.get('[data-test="theme-dark"]').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(loadTheme()).toBe('dark');
    expect(w.get('[data-test="theme-dark"]').attributes('aria-checked')).toBe('true');
    expect(w.find('[data-test="theme-dark"] svg').exists()).toBe(true);
    await group.trigger('keydown', { key: 'ArrowLeft' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(loadTheme()).toBe('light');
  });

  it('Tab wraps inside the screen (modal)', async () => {
    const w = screen();
    const root = w.get('[data-test="settings"]');
    expect(root.attributes('aria-modal')).toBe('true');
    const close = w.get('[data-test="settings-close"]').element as HTMLElement;
    close.focus();
    await root.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(w.get('[data-test="settings-nav-general"]').element);
    await root.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('restore confirm is modal: starts on Cancel, Escape cancels it (not Settings), focus returns', async () => {
    const w = screen();
    await w.get('[data-test="settings-nav-backups"]').trigger('click');
    const opener = w.get('[data-test="restore-pick"]').element as HTMLElement;
    opener.focus();
    // #86: Restore asks first; the backend opens the file picker after confirming. No path field.
    await w.get('[data-test="restore-pick"]').trigger('click');
    expect(w.emitted('askRestore')).toHaveLength(1);
    expect(w.find('[data-test="restore-path"]').exists()).toBe(false);
    await w.setProps({ confirmingRestore: true });
    await flushPromises();
    const dlg = w.get('[data-test="restore-confirm"]');
    expect(dlg.attributes('role')).toBe('alertdialog');
    expect(dlg.attributes('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(w.get('[data-test="restore-confirm-no"]').element);
    await dlg.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(w.get('[data-test="restore-confirm-yes"]').element);
    await dlg.trigger('keydown', { key: 'Escape' });
    expect(w.emitted('cancelRestore')).toHaveLength(1);
    expect(w.emitted('close')).toBeUndefined();
    await w.setProps({ confirmingRestore: false });
    await flushPromises();
    expect(document.activeElement).toBe(opener);
  });

  it('restore confirm puts Cancel first, then the danger button (PM, #102)', async () => {
    const w = screen();
    await w.setProps({ confirmingRestore: true });
    await flushPromises();
    const order = w
      .findAll('[data-test="restore-confirm"] button')
      .map((b) => b.attributes('data-test'));
    expect(order).toEqual(['restore-confirm-no', 'restore-confirm-yes']);
    expect(document.activeElement).toBe(w.get('[data-test="restore-confirm-no"]').element);
  });

  it('restore copy says "key", and the banner live region stays mounted after Dismiss', async () => {
    const w = screen({ confirmingRestore: true, tokensNotice: 3 });
    const text = w.get('[data-test="settings-backups"]').text();
    expect(text).toContain('the backup you choose next, and turns off all agent keys.');
    expect(text).toContain('turned off all 3 agent key(s)');
    expect(text).toContain('create new keys in Settings > Agents');
    expect(text.toLowerCase()).not.toContain('token');
    await w.setProps({ tokensNotice: null, confirmingRestore: false });
    expect(w.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    expect(w.get('[data-test="tokens-revoked-live"]').attributes('role')).toBe('status');
    expect(w.get('[data-test="backup-status"]').attributes('role')).toBe('status');
  });
});

describe('Your name & color (#99)', () => {
  it('Save keeps the name and color across a reopen', async () => {
    const w = mount(NameColorSection);
    await w.get('[data-test="settings-name"]').setValue('  Sample Writer  ');
    await w.get('[data-test="swatch-5"]').trigger('click');
    await w.get('[data-test="settings-save"]').trigger('click');
    await flushPromises();
    expect(loadProfile()).toEqual({ name: 'Sample Writer', color: 5 });
    w.unmount();
    const again = mount(NameColorSection);
    expect((again.get('[data-test="settings-name"]').element as HTMLInputElement).value).toBe(
      'Sample Writer',
    );
    expect(again.get('[data-test="swatch-5"]').attributes('aria-checked')).toBe('true');
    expect(again.get('[data-test="settings-name-status"]').attributes('role')).toBe('status');
  });

  it('shows a clear error when the name matches an agent (#45)', async () => {
    const w = mount(NameColorSection, {
      props: {
        syncDisplayName: async () => {
          throw '"Grok Bot" is already used by an agent; choose another name';
        },
      },
    });
    await w.get('[data-test="settings-name"]').setValue('Grok Bot');
    await w.get('[data-test="settings-save"]').trigger('click');
    await flushPromises();
    const input = w.get('[data-test="settings-name"]');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe('nc-name-error');
    expect(w.get('[data-test="settings-name-error"]').text()).toContain(
      'already used by an agent',
    );
    expect(loadProfile().name).toBe('Author');
  });

  it('shows a clear error when the name is reserved (#184)', async () => {
    const w = mount(NameColorSection, {
      props: {
        syncDisplayName: async () => {
          throw '"You" is reserved; choose another name';
        },
      },
    });
    await w.get('[data-test="settings-name"]').setValue('You');
    await w.get('[data-test="settings-save"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="settings-name-error"]').text()).toContain('reserved');
    expect(loadProfile().name).toBe('Author');
  });

  it('shows reserved when Grok Bot is not an agent yet (#184, Windows QA)', async () => {
    const w = mount(NameColorSection, {
      props: {
        syncDisplayName: async () => {
          throw '"Grok Bot" is reserved; choose another name';
        },
      },
    });
    await w.get('[data-test="settings-name"]').setValue('Grok Bot');
    await w.get('[data-test="settings-save"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="settings-name-error"]').text()).toContain('reserved');
    expect(loadProfile().name).toBe('Author');
  });

  it('unsaved edits are not kept; a broken stored value falls back to the default', async () => {
    const w = mount(NameColorSection);
    await w.get('[data-test="settings-name"]').setValue('Unsaved');
    w.unmount();
    expect(loadProfile().name).toBe('Author');
    localStorage.setItem(PROFILE_KEY, '{not json');
    expect(loadProfile()).toEqual({ name: 'Author', color: 3 });
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: 'X', color: 99 }));
    expect(loadProfile()).toEqual({ name: 'X', color: 3 });
  });
});
