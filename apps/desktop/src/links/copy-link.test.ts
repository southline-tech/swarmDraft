import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc } from '@swarmdraft/docx';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import { COPY_LINK_DISABLED_REASON } from './link-codec';

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
    expect(item.text()).toContain('Copy link to change');
    expect(item.attributes('aria-disabled')).toBeUndefined();
    const comment = w.get('[data-test="ctx-comment"]');
    expect(
      item.element.compareDocumentPosition(comment.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await item.trigger('click');
    await flushPromises();
    expect(written).toEqual(['swarmdraft://open?draft=book-17&change=sample-s1']);
    expect(w.emitted('copy-link')?.[0]).toEqual([true]);
    w.unmount();
  });

  it('disables Copy link to change when the click is not on a tracked change', async () => {
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
    const item = w.get('[data-test="ctx-copy_link"]');
    expect(item.attributes('aria-disabled')).toBe('true');
    expect(item.attributes('aria-describedby')).toBe('ctx-reason-copy_link');
    expect(item.text()).toContain(COPY_LINK_DISABLED_REASON);
    expect(item.classes()).toContain('sh-mi--stack');
    await item.trigger('click');
    await flushPromises();
    expect(w.emitted('copy-link')).toBeUndefined();
    w.unmount();
  });

  it('reports a clipboard failure instead of succeeding silently', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
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
    await w.get('[data-test="ctx-copy_link"]').trigger('click');
    await flushPromises();
    expect(w.emitted('copy-link')?.[0]).toEqual([false]);
    w.unmount();
  });
});
