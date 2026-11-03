import { describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DraftPicker from './DraftPicker.vue';
import { overlayWrap, overlayVisible } from '../overlay/queries';

describe('DraftPicker (#243)', () => {
  it('lists drafts as menuitemradio with the current draft marked', async () => {
    const w = mount(DraftPicker, {
      props: {
        label: 'Active',
        currentId: 'a',
        drafts: [
          { id: 'a', title: 'First draft' },
          { id: 'b', title: 'Second draft' },
        ],
      },
      attachTo: document.body,
    });
    await w.find('[data-test="draft-picker"]').trigger('click');
    await flushPromises();
    const items = overlayWrap('[data-test="draft-menu"]').findAll('[data-test="draft-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.attributes('aria-checked')).toBe('true');
    expect(items[1]!.attributes('aria-checked')).toBe('false');
    expect(items[0]!.classes()).toContain('tb-menu-item--on');
    w.unmount();
  });

  it('emits select when picking a different draft', async () => {
    const w = mount(DraftPicker, {
      props: {
        label: 'First draft',
        currentId: 'a',
        drafts: [
          { id: 'a', title: 'First draft' },
          { id: 'b', title: 'Second draft' },
        ],
      },
      attachTo: document.body,
    });
    await w.find('[data-test="draft-picker"]').trigger('click');
    await overlayWrap('[data-test="draft-item"][data-draft="b"]').trigger('click');
    expect(w.emitted('select')).toEqual([['b']]);
    w.unmount();
  });

  it('emits menu-open when the menu opens', async () => {
    const w = mount(DraftPicker, {
      props: { label: 'Only', currentId: 'x', drafts: [{ id: 'x', title: 'Only' }] },
      attachTo: document.body,
    });
    await w.find('[data-test="draft-picker"]').trigger('click');
    expect(w.emitted('menu-open')).toHaveLength(1);
    w.unmount();
  });

  it('closes on Escape and refocuses the trigger', async () => {
    const w = mount(DraftPicker, {
      props: { label: 'Only', currentId: 'x', drafts: [{ id: 'x', title: 'Only' }] },
      attachTo: document.body,
    });
    const trigger = w.get('[data-test="draft-picker"]');
    await trigger.trigger('click');
    await flushPromises();
    expect(overlayVisible('[data-test="draft-menu"]')).toBe(true);
    await overlayWrap('[data-test="draft-menu"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(overlayVisible('[data-test="draft-menu"]')).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    w.unmount();
  });
});
