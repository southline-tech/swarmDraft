import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import StatusBarZoom from '../status/StatusBarZoom.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import { PAGE, ZOOM_STORAGE_KEY, clampZoom, loadZoom, saveZoom, stepZoom } from './zoom';

beforeEach(() => localStorage.clear());

describe('zoom model', () => {
  it('uses an 864px page height, 72px sheet padding, and a 70ch text measure at 100% zoom', () => {
    expect(PAGE).toEqual({ height: 864, margin: 72, measureCh: 70 });
  });
  it('clamps to 50-200 and steps through levels, stopping at the ends', () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(900)).toBe(200);
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(103, -1)).toBe(100);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
  });
  it('persists, and falls back to 100 for missing, bad, or unavailable storage', () => {
    expect(loadZoom()).toBe(100);
    saveZoom(150);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('150');
    expect(loadZoom()).toBe(150);
    for (const blank of ['', '   ']) {
      localStorage.setItem(ZOOM_STORAGE_KEY, blank);
      expect(loadZoom()).toBe(100);
    }
    localStorage.setItem(ZOOM_STORAGE_KEY, 'junk');
    expect(loadZoom()).toBe(100);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadZoom(broken)).toBe(100);
  });
});

describe('StatusBarZoom', () => {
  it('steps, resets, aria-disables (still focusable, no-op) only at the ends, and binds no shortcuts', async () => {
    const w = mount(StatusBarZoom, {
      props: {
        modelValue: 50,
        'onUpdate:modelValue': (v: number) => w.setProps({ modelValue: v }),
      },
    });
    const out = w.find('[data-test="status-zoom-out"]');
    expect(out.attributes('disabled')).toBeUndefined();
    expect(out.attributes('aria-disabled')).toBe('true');
    await out.trigger('click');
    expect(w.props('modelValue')).toBe(50);
    expect(w.find('[data-test="status-zoom-in"]').attributes('aria-disabled')).toBeUndefined();
    await w.find('[data-test="status-zoom-in"]').trigger('click');
    expect(w.props('modelValue')).toBe(67);
    await w.setProps({ modelValue: 200 });
    const zin = w.find('[data-test="status-zoom-in"]');
    expect(zin.attributes('disabled')).toBeUndefined();
    expect(zin.attributes('aria-disabled')).toBe('true');
    await zin.trigger('click');
    expect(w.props('modelValue')).toBe(200);
    expect(w.find('[data-test="status-zoom-out"]').attributes('aria-disabled')).toBeUndefined();
    expect(w.find('[data-test="status-zoom-reset"]').text()).toBe('200%');
    expect(w.find('[data-test="status-zoom-reset"]').attributes('aria-label')).toBe(
      'Reset zoom, 100%',
    );
    await w.find('[data-test="status-zoom-reset"]').trigger('click');
    expect(w.props('modelValue')).toBe(100);
    expect(w.findAll('[aria-keyshortcuts]')).toHaveLength(0);
    for (const el of w.findAll('[title]')) expect(el.attributes('title')).not.toMatch(/Ctrl/);
    w.unmount();
  });

  it('compact mode exposes menu popup semantics (#207)', () => {
    const w = mount(StatusBarZoom, { props: { modelValue: 100, compact: true } });
    expect(w.find('[data-test="status-zoom-reset"]').attributes('aria-haspopup')).toBe('menu');
    w.unmount();
  });
});

describe('page on desk', () => {
  it('centers the page sheet on the desk with token shadow, padding and Literata', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const desk = w.find('[data-test="desk"]');
    expect(desk.classes()).toEqual(expect.arrayContaining(['bg-bg', 'overflow-auto']));
    // Overflow-safe centering: auto margins, never justify-center, so the left edge stays reachable.
    expect(desk.classes()).not.toContain('justify-center');
    expect(desk.find('[data-test="page"]').classes()).toContain('mx-auto');
    const page = desk.find('[data-test="page"]');
    expect(page.classes()).toEqual(
      expect.arrayContaining(['box-border', 'min-h-216', 'p-18', 'bg-paper', 'shadow-2']),
    );
    expect(page.find('.tiptap').exists()).toBe(true);
    expect(w.html()).not.toMatch(/Georgia/);
    w.unmount();
  });

  it('scales the page (no reflow) from the footer zoom control and remembers the level', async () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, '125');
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = () => w.find('[data-test="page"]');
    expect(page().attributes('style')).toContain('zoom: 1.25');
    expect(w.find('[data-test="status-zoom-reset"]').text()).toBe('125%');
    await w.find('[data-test="status-zoom-in"]').trigger('click');
    expect(page().attributes('style')).toContain('zoom: 1.5');
    // #92: the width is the fluid CSS rule (page-width.test.ts), not a fixed utility class.
    expect(page().classes()).not.toContain('w-144');
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('150');
    w.unmount();
  });

  it('keeps zoom usable while the document is read-only', async () => {
    const bad = { type: 'doc', content: [{ type: 'table' }] };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    await flushPromises();
    // The error fills its assertive region one frame after it is set (#79).
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await w.vm.$nextTick();
    expect(w.find('[data-test="load-error"]').exists()).toBe(true);
    await w.find('[data-test="status-zoom-out"]').trigger('click');
    expect(w.find('[data-test="page"]').attributes('style')).toContain('zoom: 0.9');
    w.unmount();
  });
});
