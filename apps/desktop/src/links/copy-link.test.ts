import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc } from '@swarmdraft/docx';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';

describe('Copy link (#117)', () => {
  it('puts the change url on the clipboard from the context menu', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
        readText: async () => '',
      },
    });
    const w = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), manuscriptId: 'book-17' },
      attachTo: document.body,
    });
    await flushPromises();
    const mark = w.get('ins[data-id="sample-s1"]');
    await mark.trigger('contextmenu', { clientX: 40, clientY: 40 });
    await flushPromises();
    const item = w.get('[data-test="ctx-copy_link"]');
    expect(item.text()).toContain('Copy link');
    await item.trigger('click');
    await flushPromises();
    expect(written).toEqual(['swarmdraft://open?draft=book-17&change=sample-s1']);
    w.unmount();
  });

  it('hides Copy link on text that is not a tracked change', async () => {
    const w = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), manuscriptId: 'book-17' },
      attachTo: document.body,
    });
    await flushPromises();
    const plain = [...w.element.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('Morning came late.'),
    );
    expect(plain).toBeTruthy();
    plain!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
    await flushPromises();
    expect(w.find('[data-test="context-menu"]').exists()).toBe(true);
    expect(w.find('[data-test="ctx-copy_link"]').exists()).toBe(false);
    w.unmount();
  });
});
