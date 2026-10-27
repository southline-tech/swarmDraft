import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MigrationNoticeBanner from './MigrationNoticeBanner.vue';
import type { MigrationNotice } from '../backend';
import { PRODUCT_NAME } from '../lib/brand';

const kept: MigrationNotice = { id: 'migration-kept', kind: 'info', text: 'Old files kept.' };
const locked: MigrationNotice = { id: 'migration-locked', kind: 'warn', text: 'Close the old app.' };
const other: MigrationNotice = { id: 'migration-other', kind: 'warn', text: 'Another app is open.' };

describe('MigrationNoticeBanner', () => {
  it('renders warn notices in role=alert and info notices in role=status, each with its variant', () => {
    const w = mount(MigrationNoticeBanner, { props: { notices: [kept, locked] } });
    const warn = w.find('[role="alert"] [data-test="migration-notice"]');
    const info = w.find('[role="status"] [data-test="migration-notice"]');
    expect(warn.classes()).toContain('migration-notice--warn');
    expect(warn.text()).toContain('Close the old app.');
    expect(warn.text()).not.toContain('Old files kept.');
    expect(info.classes()).toContain('migration-notice--info');
    expect(info.text()).toContain('Old files kept.');
    expect(info.text()).not.toContain('Close the old app.');
  });

  it('shows every notice of a kind and dismisses exactly the shown ids', async () => {
    const w = mount(MigrationNoticeBanner, { props: { notices: [locked, kept, other] } });
    const warn = w.find('[data-kind="warn"]');
    expect(warn.findAll('p.text').map((p) => p.text())).toEqual([
      'Close the old app.',
      'Another app is open.',
    ]);
    const btn = warn.find('[data-test="migration-notice-dismiss"]');
    expect(btn.attributes('aria-label')).toBe(`Dismiss ${PRODUCT_NAME} update warnings`);
    await btn.trigger('click');
    expect(w.emitted('dismiss')).toEqual([[['migration-locked', 'migration-other']]]);
  });

  it('keeps both live regions mounted with no notices', () => {
    const w = mount(MigrationNoticeBanner, { props: { notices: [] } });
    expect(w.find('[role="alert"]').exists()).toBe(true);
    expect(w.find('[role="status"]').exists()).toBe(true);
    expect(w.find('[data-test="migration-notice"]').exists()).toBe(false);
  });
});
