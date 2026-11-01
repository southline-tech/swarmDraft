import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import type { SpellIssue } from '@swarmdraft/editor';
import SpellMenu from './SpellMenu.vue';

enableAutoUnmount(afterEach);

function issue(partial: Partial<SpellIssue> & Pick<SpellIssue, 'kind'>): SpellIssue {
  return {
    id: '1',
    from: 1,
    to: 2,
    message: 'Test message',
    suggestions: ['one', 'two', 'three', 'four'],
    word: 'test',
    ...partial,
  };
}

describe('SpellMenu (#159)', () => {
  it('uses Spelling or Grammar as the menu aria-label', () => {
    const spelling = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'spelling' }) },
    });
    expect(spelling.get('[role=menu]').attributes('aria-label')).toBe('Spelling');
    spelling.unmount();

    const grammar = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'grammar' }) },
    });
    expect(grammar.get('[role=menu]').attributes('aria-label')).toBe('Grammar');
  });

  it('shows at most three suggestions', () => {
    const w = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'spelling' }) },
    });
    expect(w.findAll('[data-action=suggest]')).toHaveLength(3);
    expect(w.text()).toContain('one');
    expect(w.text()).not.toContain('four');
  });

  it('returns focus to the editor on Escape, Ignore, and Add to dictionary', async () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.tabIndex = 0;
    const shell = document.createElement('div');
    shell.className = 'manuscript-editor';
    shell.append(editor);
    document.body.append(shell);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const w = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'spelling' }) },
    });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-action')).toBe('suggest');

    await w.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(document.activeElement).toBe(editor);

    editor.blur();
    (w.get('[data-test=spell-ignore]').element as HTMLElement).focus();
    await w.get('[data-test=spell-ignore]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(editor);

    editor.blur();
    (w.get('[data-test=spell-dictionary]').element as HTMLElement).focus();
    await w.get('[data-test=spell-dictionary]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(editor);

    shell.remove();
  });

  it('emits suggest when a suggestion is clicked', async () => {
    const w = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'spelling' }) },
    });
    await w.get('[data-test=spell-suggest-primary]').trigger('click');
    expect(w.emitted('suggest')).toEqual([['one']]);
    w.unmount();
  });

  it('returns focus to the editor when unmounted (backdrop dismiss)', async () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.tabIndex = 0;
    const shell = document.createElement('div');
    shell.className = 'manuscript-editor';
    shell.append(editor);
    document.body.append(shell);
    editor.focus();

    const w = mount(SpellMenu, {
      attachTo: document.body,
      props: { x: 0, y: 0, issue: issue({ kind: 'grammar' }) },
    });
    await flushPromises();
    w.unmount();
    await flushPromises();
    expect(document.activeElement).toBe(editor);
    shell.remove();
  });
});
