import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Y from 'yjs';
import ShellsPreview from './ShellsPreview.vue';
import SettingsScreen from './SettingsScreen.vue';
import ReasonLine from './ReasonLine.vue';
import { SCREENS, readPreview, applyThemeParam } from './preview';

describe('UI shells (Part of #36)', () => {
  it.each(SCREENS.map((s) => s.id))('renders %s on its own', (id) => {
    const w = mount(ShellsPreview, { props: { initial: id } });
    expect(w.find(`[data-screen="${id}"]`).exists()).toBe(true);
    expect(w.findAll('[data-screen]')).toHaveLength(1);
  });

  it('renders every surface in the "all" view', () => {
    const w = mount(ShellsPreview, { props: { initial: 'all' } });
    for (const t of [
      'name-prompt',
      'settings-screen',
      'opening-progress',
      'toast',
      'save-failure-banner',
      'reason-line',
    ])
      expect(w.find(`[data-test="${t}"]`).exists(), t).toBe(true);
    expect(w.findAll('[data-test="empty-state"]')).toHaveLength(3);
    expect(w.findAll('[data-test="error-card"]')).toHaveLength(5);
  });

  it('toast dismisses and can be shown again', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'ob7' } });
    await w.get('[data-test="toast-dismiss"]').trigger('click');
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    await w.get('[data-test="toast-show"]').trigger('click');
    expect(w.find('[data-test="toast"]').exists()).toBe(true);
  });

  it('settings: taken swatches cannot be picked; save only emits', async () => {
    const w = mount(SettingsScreen);
    await w.get('[data-test="swatch-1"]').trigger('click');
    expect(w.get('[data-test="swatch-3"]').attributes('aria-checked')).toBe('true');
    await w.get('[data-test="swatch-4"]').trigger('click');
    await w.get('[data-test="settings-save"]').trigger('click');
    expect(w.emitted('save')?.[0]).toEqual([{ name: 'Kim', color: 4 }]);
  });

  it('reason line clamps long text with More/Less', async () => {
    const w = mount(ReasonLine, { props: { reason: 'x'.repeat(200) } });
    expect(w.get('[data-test="reason-more"]').text()).toBe('More');
    await w.get('[data-test="reason-more"]').trigger('click');
    expect(w.get('[data-test="reason-more"]').text()).toBe('Less');
    expect(
      mount(ReasonLine, { props: { reason: 'Short.' } })
        .find('[data-test="reason-more"]')
        .exists(),
    ).toBe(false);
  });

  it('preview param parsing ignores unknown ids; theme param sets data-theme', () => {
    expect(readPreview('?preview=ob9')).toBe('ob9');
    expect(readPreview('?preview=all')).toBe('all');
    expect(readPreview('?preview=nope')).toBeNull();
    const el = document.createElement('div');
    applyThemeParam('?theme=dark', el);
    expect(el.dataset.theme).toBe('dark');
  });

  it('clicking every control in every shell leaves manuscript text unchanged', async () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, [new Y.XmlText('naïve café — 😀 sample text')]);
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    const w = mount(ShellsPreview, { props: { initial: 'all' }, attachTo: document.body });
    for (const b of w.findAll('button')) if (b.element.isConnected) await b.trigger('click');
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    w.unmount();
  });
});
