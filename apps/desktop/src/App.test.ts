import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

describe('App', () => {
  it('renders in browser mode without the desktop backend', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('coAuthor');
    expect(wrapper.find('[data-test="browser-mode"]').exists()).toBe(true);
  });
});
