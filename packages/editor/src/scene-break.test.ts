import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { SCENE_BREAK_DISPLAY, SCENE_BREAK_MARKER } from './extensions';
import { createManuscriptEditor } from './index';

let editor: Editor;
afterEach(() => editor?.destroy());

describe('scene break display', () => {
  it('renders centered display text while preserving the stored marker', () => {
    editor = createManuscriptEditor({
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Before.' }] },
          { type: 'scene_break', attrs: { marker: '---' } },
          { type: 'paragraph', content: [{ type: 'text', text: 'After.' }] },
        ],
      },
    });
    const el = editor.view.dom.querySelector('.scene-break');
    expect(el?.textContent).toBe(SCENE_BREAK_DISPLAY);
    expect(el?.getAttribute('data-marker')).toBe('---');
    expect(editor.getJSON().content?.[1]).toEqual({
      type: 'scene_break',
      attrs: { marker: '---' },
    });
  });

  it('round-trips HTML with display text and original marker attribute', () => {
    editor = createManuscriptEditor({
      content: {
        type: 'doc',
        content: [{ type: 'scene_break', attrs: { marker: '***' } }],
      },
    });
    const html = editor.getHTML();
    expect(html).toContain(`data-marker="${SCENE_BREAK_MARKER}"`);
    expect(html).toContain(SCENE_BREAK_DISPLAY);
    editor.destroy();
    editor = createManuscriptEditor({ content: html });
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'scene_break', attrs: { marker: SCENE_BREAK_MARKER } }],
    });
  });
});
