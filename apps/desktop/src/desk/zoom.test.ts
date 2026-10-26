import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import ZoomControl from './ZoomControl.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import { PAGE, ZOOM_STORAGE_KEY, clampZoom, loadZoom, saveZoom, stepZoom } from './zoom';

beforeEach(() => localStorage.clear());

describe('zoom model', () => {
  it('is a 6x9 in trim at 96 px/in with 0.75 in margins and a 432 px text block', () => {
    expect(PAGE).toEqual({ width: 576, height: 864, margin: 72 });
    expect(PAGE.width - 2 * PAGE.margin).toBe(432);
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

describe('ZoomControl', () => {
  it('steps, resets, disables only at the ends, and binds no shortcuts', async () => {
    const w = mount(ZoomControl, {
      props: {
        modelValue: 50,
        'onUpdate:modelValue': (v: number) => w.setProps({ modelValue: v }),
      },
    });
    expect(w.find('[data-test="zoom-out"]').attributes('disabled')).toBeDefined();
    await w.find('[data-test="zoom-in"]').trigger('click');
    expect(w.props('modelValue')).toBe(67);
    await w.find('[data-test="zoom-slider"]').setValue('200');
    expect(w.props('modelValue')).toBe(200);
    expect(w.find('[data-test="zoom-in"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-test="zoom-reset"]').text()).toBe('200%');
    await w.find('[data-test="zoom-reset"]').trigger('click');
    expect(w.props('modelValue')).toBe(100);
    expect(w.findAll('[aria-keyshortcuts]')).toHaveLength(0);
    for (const el of w.findAll('[title]')) expect(el.attributes('title')).not.toMatch(/Ctrl/);
    w.unmount();
  });
});

describe('page on desk', () => {
  it('centers a 576 px paper page on the desk with token shadow, margins and Literata', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const desk = w.find('[data-test="desk"]');
    expect(desk.classes()).toEqual(
      expect.arrayContaining(['bg-bg', 'justify-center', 'overflow-y-auto']),
    );
    const page = desk.find('[data-test="page"]');
    expect(page.classes()).toEqual(
      expect.arrayContaining(['box-border', 'w-144', 'min-h-216', 'p-18', 'bg-paper', 'shadow-2']),
    );
    expect(page.find('.tiptap').exists()).toBe(true);
    expect(w.html()).not.toMatch(/Georgia/);
    w.unmount();
  });

  it('scales the page (no reflow) from the status bar and remembers the level', async () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, '125');
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = () => w.find('[data-test="page"]');
    expect(page().attributes('style')).toContain('zoom: 1.25');
    expect(w.find('[data-test="status-bar"] [data-test="zoom-reset"]').text()).toBe('125%');
    await w.find('[data-test="zoom-in"]').trigger('click');
    expect(page().attributes('style')).toContain('zoom: 1.5');
    expect(page().classes()).toContain('w-144');
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('150');
    w.unmount();
  });

  it('keeps zoom usable while the document is read-only', async () => {
    const bad = { type: 'doc', content: [{ type: 'table' }] };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="load-error"]').exists()).toBe(true);
    await w.find('[data-test="zoom-out"]').trigger('click');
    expect(w.find('[data-test="page"]').attributes('style')).toContain('zoom: 0.9');
    w.unmount();
  });
});
