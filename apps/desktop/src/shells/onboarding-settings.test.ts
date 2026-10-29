import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Y from 'yjs';
import ShellsPreview from './ShellsPreview.vue';
import SettingsScreen from './SettingsScreen.vue';
import ReasonLine from './ReasonLine.vue';
import { SCREENS, readPreview, applyThemeParam } from './preview';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

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
      'toast-region',
      'save-failure-banner',
      'reason-line',
    ])
      expect(w.find(`[data-test="${t}"]`).exists(), t).toBe(true);
    expect(w.findAll('[data-test="empty-state"]')).toHaveLength(3);
    expect(w.findAll('[data-test="error-card"]')).toHaveLength(5);
  });

  it('toast keeps one persistent polite live region across open and dismiss (#79)', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'ob7' } });
    const node = w.get('[data-test="toast-region"]').element;
    expect(node.getAttribute('aria-live')).toBe('polite');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.textContent?.trim()).toBe('');
    await frame();
    await w.vm.$nextTick();
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.textContent).toContain('Your book is open.');
    await w.get('[data-test="toast-dismiss"]').trigger('click');
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.textContent?.trim()).toBe('');
    await w.get('[data-test="toast-show"]').trigger('click');
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.textContent).toContain('Your book is open.');
  });

  it('toast dismisses and can be shown again', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'ob7' } });
    await frame();
    await w.vm.$nextTick();
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
    expect(w.emitted('save')?.[0]).toEqual([{ name: 'Sample Author', color: 4 }]);
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
    const w = mount(ShellsPreview, { props: { initial: 'all', doc }, attachTo: document.body });
    // Save first (clicking settings nav later would unmount it), then every other button.
    await w.find('[data-test="settings-save"]').trigger('click');
    for (const b of w.findAll('button')) if (b.element.isConnected) await b.trigger('click');
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    w.unmount();
  });

  it('tc3 name prompt is an inline card, not a dialog without modal behavior', () => {
    const w = mount(ShellsPreview, { props: { initial: 'tc3' } });
    const card = w.find('[data-test="name-prompt"]');
    expect(card.exists()).toBe(true);
    expect(card.attributes('role')).toBe('status');
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(card.attributes('aria-labelledby')).toBe('np-title');
    w.unmount();
  });

  it('tc4 sample filter narrows review cards by author kind (preview only)', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'tc4' } });
    const cards = () => w.findAll('[data-test="preview-tc4"] .pw__card').length;
    expect(cards()).toBe(3);
    await w.find('[role="radio"]:nth-child(3)').trigger('click');
    expect(cards()).toBe(1);
    await w.find('.pw__card .sh-btn--primary').trigger('click');
    expect(w.find('[data-test="stub-note"]').text()).toContain('preview only');
    w.unmount();
  });

  it('wp8 step-through counts only the authors that are shown (preview only)', async () => {
    const w = mount(ShellsPreview, { props: { initial: 'wp8' } });
    const pos = () => w.find('[data-test="step-pos"]').text();
    expect(pos()).toBe('3 of 12');
    await w.find('[aria-label="Next change"]').trigger('click');
    expect(pos()).toBe('4 of 12');
    await w.findAll('.pw__authors input').at(0)!.setValue(false);
    expect(pos()).toBe('3 of 3');
    w.unmount();
  });

  it('wp2 collapses both sidebars to rails (preview only)', () => {
    const w = mount(ShellsPreview, { props: { initial: 'wp2' } });
    expect(w.find('[aria-label="Show chapters"]').exists()).toBe(true);
    expect(w.find('[aria-label="Show review"]').exists()).toBe(true);
    expect(w.find('[data-test="preview-wp2"] .pw__nav').exists()).toBe(false);
    w.unmount();
  });
});
