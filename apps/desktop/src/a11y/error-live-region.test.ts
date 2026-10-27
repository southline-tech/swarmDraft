import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ErrorCard from '../shells/ErrorCard.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe('assertive error live regions (#79)', () => {
  it('ErrorCard: empty assertive region at mount, card text lands in the same node', async () => {
    const w = mount(ErrorCard, {
      props: {
        icon: 'alert',
        tone: 'danger',
        title: 'Could not open',
        text: 'Try again.',
        action: 'Retry',
      },
    });
    const region = w.get('[data-test="error-region"]');
    expect(region.attributes('role')).toBe('alert');
    expect(region.attributes('aria-live')).toBe('assertive');
    expect(region.text()).toBe('');
    const node = region.element;
    await frame();
    await w.vm.$nextTick();
    const after = w.get('[data-test="error-region"]');
    expect(after.element).toBe(node);
    expect(after.text()).toContain('Could not open');
    expect(after.find('[data-test="error-card"]').exists()).toBe(true);
  });

  it('ManuscriptEditor: load-error region is mounted empty, then the error appears inside it', async () => {
    const bad = { type: 'doc', content: [{ type: 'table' }] };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    const region = w.get('[data-test="load-error-region"]');
    expect(region.attributes('aria-live')).toBe('assertive');
    const node = region.element;
    await flushPromises();
    expect(w.get('[data-test="load-error-region"]').text()).toBe('');
    await frame();
    await w.vm.$nextTick();
    const after = w.get('[data-test="load-error-region"]');
    expect(after.element).toBe(node);
    expect(after.text()).toContain('opened read-only');
    w.unmount();
  });
});
