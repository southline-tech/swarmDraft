import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StoryNotesSheet from './StoryNotesSheet.vue';
import { createNotesDoc } from './doc';
import { STORY_NOTES_SHEET_HEIGHT_KEY } from './prefs';
import { ensureOverlayLayer } from '../overlay/layer';
import { overlayWrap } from '../overlay/queries';

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem(STORY_NOTES_SHEET_HEIGHT_KEY);
});

describe('StoryNotesSheet', () => {
  it('resizes by 24px with arrow keys and persists height', async () => {
    ensureOverlayLayer();
    const anchor = document.createElement('div');
    anchor.dataset.test = 'continuous-manuscript';
    document.body.appendChild(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      right: 700,
      bottom: 650,
      width: 600,
      height: 600,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    const notesDoc = createNotesDoc();
    const w = mount(StoryNotesSheet, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        anchorSelector: "[data-test='continuous-manuscript']",
      },
    });
    await flushPromises();
    await vi.waitFor(() =>
      expect(overlayWrap('[data-test="story-notes-sheet-resize"]').exists()).toBe(true),
    );

    const sheetEl = overlayWrap('[data-test="story-notes-sheet"]').element as HTMLElement;
    const before = Number(sheetEl.style.height.replace('px', ''));
    await overlayWrap('[data-test="story-notes-sheet-resize"]').trigger('keydown', {
      key: 'ArrowUp',
    });
    const afterUp = Number(sheetEl.style.height.replace('px', ''));
    expect(afterUp - before).toBe(24);
    expect(localStorage.getItem(STORY_NOTES_SHEET_HEIGHT_KEY)).toBe(String(afterUp));

    await overlayWrap('[data-test="story-notes-sheet-resize"]').trigger('keydown', {
      key: 'ArrowDown',
    });
    const afterDown = Number(sheetEl.style.height.replace('px', ''));
    expect(afterDown).toBe(before);

    w.unmount();
    localStorage.setItem(STORY_NOTES_SHEET_HEIGHT_KEY, String(360));
    mount(StoryNotesSheet, {
      attachTo: document.body,
      props: {
        notesDoc,
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        anchorSelector: "[data-test='continuous-manuscript']",
      },
    });
    await flushPromises();
    await vi.waitFor(() => {
      const h2 = Number(
        (
          overlayWrap('[data-test="story-notes-sheet"]').element as HTMLElement
        ).style.height.replace('px', ''),
      );
      expect(h2).toBe(360);
    });
  });

  it('positions the sheet to the anchor column only (not a wider parent)', async () => {
    ensureOverlayLayer();
    const stack = document.createElement('div');
    stack.dataset.test = 'editor-stack';
    document.body.appendChild(stack);
    const anchor = document.createElement('div');
    anchor.dataset.test = 'continuous-manuscript';
    stack.appendChild(anchor);
    vi.spyOn(stack, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 40,
      right: 1200,
      bottom: 800,
      width: 1000,
      height: 760,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 40,
      right: 900,
      bottom: 800,
      width: 700,
      height: 760,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);

    const w = mount(StoryNotesSheet, {
      attachTo: document.body,
      props: {
        notesDoc: createNotesDoc(),
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
      },
    });
    await flushPromises();
    await vi.waitFor(() =>
      expect(overlayWrap('[data-test="story-notes-sheet"]').exists()).toBe(true),
    );
    const sheet = overlayWrap('[data-test="story-notes-sheet"]').element as HTMLElement;
    expect(sheet.style.left).toBe('200px');
    expect(sheet.style.width).toBe('700px');
    w.unmount();
  });

  it('clamps height between 240px and 70% of the anchor', async () => {
    ensureOverlayLayer();
    const anchor = document.createElement('div');
    anchor.dataset.test = 'continuous-manuscript';
    document.body.appendChild(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const w = mount(StoryNotesSheet, {
      attachTo: document.body,
      props: {
        notesDoc: createNotesDoc(),
        outline: [],
        humanAuthor: { id: 'h', name: 'Author' },
        anchorSelector: "[data-test='continuous-manuscript']",
      },
    });
    await flushPromises();
    await vi.waitFor(() =>
      expect(overlayWrap('[data-test="story-notes-sheet-resize"]').exists()).toBe(true),
    );
    for (let i = 0; i < 20; i++) {
      await overlayWrap('[data-test="story-notes-sheet-resize"]').trigger('keydown', {
        key: 'ArrowUp',
      });
    }
    const h = Number(
      (overlayWrap('[data-test="story-notes-sheet"]').element as HTMLElement).style.height.replace(
        'px',
        '',
      ),
    );
    expect(h).toBe(280);
    w.unmount();
  });
});
