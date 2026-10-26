import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './sample';

describe('ManuscriptEditor', () => {
  it('renders the document with tracked changes and comments, read-only in the review list', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = w.find('.tiptap');
    expect(page.find('ins.suggestion-insert').text()).toBe('guttered');
    expect(page.find('del.suggestion-delete').text()).toBe('flickered');
    expect(page.find('.comment-anchor').text()).toBe('rain');
    expect(page.find('.scene-break').exists()).toBe(true);
    const items = w.findAll('[data-test="review-item"]').map((i) => i.text());
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Delete');
    expect(items[1]).toContain('Insert');
    expect(items[2]).toContain('Comment');
    expect(w.find('[data-test="review"] button').exists()).toBe(false);
    w.unmount();
  });

  it('offers every paragraph style in the toolbar', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const options = w
      .findAll('[data-test="paragraph-style"] option')
      .map((o) => o.attributes('value'));
    expect(options).toEqual(['body', 'first', 'block_quote', 'epigraph', 'verse', 'centered']);
    w.unmount();
  });

  it('inserts a scene break and reports the change', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="scene-break"]').trigger('click');
    const changes = w.emitted('change');
    expect(changes?.length).toBeGreaterThan(0);
    expect(w.findAll('.tiptap .scene-break')).toHaveLength(2);
    w.unmount();
  });
});
