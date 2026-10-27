import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useDeferredValue } from './deferred';

describe('useDeferredValue (#79)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }));
  afterEach(() => vi.useRealTimers());

  const host = (src: ReturnType<typeof ref<string>>) => {
    let out!: ReturnType<typeof useDeferredValue<string | undefined>>;
    const C = defineComponent({
      setup() {
        out = useDeferredValue(src);
        return () => h('p', out.value ?? '');
      },
    });
    return { w: mount(C), out: () => out.value };
  };

  it('shows a value one frame late', async () => {
    const src = ref<string>('');
    const { w, out } = host(src);
    src.value = 'err';
    await nextTick();
    expect(out()).toBe('');
    vi.advanceTimersToNextFrame();
    expect(out()).toBe('err');
    w.unmount();
  });

  it('a value cleared before its frame fires never shows', async () => {
    const src = ref<string>('');
    const { w, out } = host(src);
    src.value = 'err';
    await nextTick();
    src.value = '';
    await nextTick();
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(out()).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    w.unmount();
  });

  it('unmounting mid-frame cancels the frame: no late write, no error', async () => {
    const src = ref<string>('');
    const { w, out } = host(src);
    src.value = 'err';
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);
    w.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersToNextFrame()).not.toThrow();
    expect(out()).toBe('');
  });
});
