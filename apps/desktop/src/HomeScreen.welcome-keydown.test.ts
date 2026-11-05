import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HomeScreen from './HomeScreen.vue';

describe('HomeScreen welcome Enter (#314)', () => {
  it('fires get-started only when Enter hits the welcome container, not a child control', async () => {
    const w = mount(HomeScreen, { props: { step: 'welcome' } });
    await w.find('[data-test="get-started"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('get-started')).toBeUndefined();

    await w.find('[data-test="home-welcome"]').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('get-started')).toHaveLength(1);
    w.unmount();
  });
});
