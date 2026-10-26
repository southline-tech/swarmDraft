import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

describe('App', () => {
  it('renders in browser mode without the desktop backend', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getAppInfo).mockResolvedValueOnce(null);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('coAuthor');
    expect(wrapper.find('[data-test="browser-mode"]').exists()).toBe(true);
  });
});

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: { list: vi.fn(async () => []), tokens: vi.fn(async () => []) },
  getAppInfo: vi.fn(async () => ({ version: '0.1.0', dataDir: '/tmp/x', schemaVersion: 1 })),
  createBackup: vi.fn(async () => '/tmp/x/backups/b.zip'),
  pickBackupToRestore: vi.fn(async () => 'D:\\Backups\\picked.zip'),
  pickBackupDestination: vi.fn(async () => 'D:\\Backups\\new.zip'),
  takeRecoveryNotice: vi.fn(async () => null),
  restoreBackup: vi.fn(async () => ({
    tokensRevoked: 2,
    manifest: {},
    preRestoreSnapshot: '/tmp/x/backups/p.zip',
  })),
}));

describe('restore confirmation', () => {
  it('does not restore until the user confirms', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="restore-path"]').setValue('C:\\Users\\a\\b.zip');
    await wrapper.find('[data-test="restore-button"]').trigger('click');
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(true);
    await wrapper.find('[data-test="restore-confirm-no"]').trigger('click');
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(false);
    await wrapper.find('[data-test="restore-button"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith('C:\\Users\\a\\b.zip');
    expect(wrapper.find('[data-test="backup-status"]').text()).toContain('p.zip');
    const notice = wrapper.find('[data-test="tokens-revoked-notice"]');
    expect(notice.text()).toContain('revoked all 2 agent token');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('tokens-revoked notice', () => {
  async function restoreOnce(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('[data-test="restore-path"]').setValue('C:\\b.zip');
    await wrapper.find('[data-test="restore-button"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
  }

  it('shows once after a restore that revoked tokens and stays gone after dismiss', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    await restoreOnce(wrapper);
    const notice = wrapper.find('[data-test="tokens-revoked-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.attributes('role')).toBe('status');
    expect(notice.text()).toContain('revoked all 2 agent token');
    expect(notice.text()).toContain('agents are kept');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    await flushPromises();
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });

  it('is not shown when no tokens were revoked', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockResolvedValueOnce({
      tokensRevoked: 0,
      manifest: {} as never,
      preRestoreSnapshot: '/tmp/x/backups/p.zip',
    });
    const wrapper = mount(App);
    await flushPromises();
    await restoreOnce(wrapper);
    expect(wrapper.find('[data-test="backup-status"]').text()).toContain('Restored');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('backup dialogs', () => {
  it('picker selects a file and still requires confirmation', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockClear();
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-target"]').text()).toBe('D:\\Backups\\picked.zip');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith('D:\\Backups\\picked.zip');
  });

  it('backup uses the save-as destination', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="backup-button"]').trigger('click');
    await flushPromises();
    expect(backend.createBackup).toHaveBeenCalledWith('D:\\Backups\\new.zip', true);
  });
});

describe('recovery notice', () => {
  it('shows the recovery folder and snapshot once, then dismisses', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.takeRecoveryNotice).mockResolvedValueOnce({
      folder: 'C:\\data\\recovery-1',
      snapshot: 'C:\\data\\backups\\pre-restore-1.zip',
      reason: 'restore journal is unreadable',
    });
    const wrapper = mount(App);
    await flushPromises();
    const n = wrapper.find('[data-test="recovery-notice"]');
    expect(n.exists()).toBe(true);
    expect(n.text()).toContain('C:\\data\\recovery-1');
    expect(n.text()).toContain('pre-restore-1.zip');
    expect(n.text()).toContain('Nothing was deleted');
    await wrapper.find('[data-test="recovery-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="recovery-notice"]').exists()).toBe(false);
  });

  it('is absent when recovery left no notice', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-test="recovery-notice"]').exists()).toBe(false);
  });
});
