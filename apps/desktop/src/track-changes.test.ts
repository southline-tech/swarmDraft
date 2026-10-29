import { describe, expect, it, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { docToYDoc } from '@coauthor/docx';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './fixtures/sample';
import {
  DEFAULT_PROFILE,
  PROFILE_KEY,
  TRACKING_KEY,
  TRACK_PROMPT_SEEN_KEY,
  loadProfile,
  loadTrackPromptSeen,
  loadTracking,
  saveProfile,
  seedProfileForTracking,
} from './settings/prefs';

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

async function mountedEditor(
  opts: { storage?: ReturnType<typeof store>; computerName?: string } = {},
) {
  const ydoc = docToYDoc(SAMPLE_DOC as never);
  const w = mount(ManuscriptEditor, {
    props: { doc: ydoc, storage: opts.storage, computerName: opts.computerName },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, ydoc };
}

describe('Track changes toggle (#57)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'light';
  });

  it('persists off/on (tc1/tc2) and shows status when on', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s });
    const t = w.get('[data-test="track-changes"]');
    expect(t.attributes('aria-pressed')).toBe('false');
    expect(t.text()).toContain('Off');
    await t.trigger('click');
    expect(t.attributes('aria-pressed')).toBe('true');
    expect(t.text()).toContain('On');
    expect(w.find('[data-test="status-tracking"]').exists()).toBe(true);
    expect(loadTracking(s)).toBe(true);
    w.unmount();
    const again = await mountedEditor({ storage: s });
    expect(again.w.get('[data-test="track-changes"]').attributes('aria-pressed')).toBe('true');
    again.w.unmount();
  });

  it('shows the tc3 name prompt once, seeds profile, and saves dismissal', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s, computerName: 'Rowan Vale' });
    await w.get('[data-test="track-changes"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(true);
    expect(loadProfile(s)).toEqual({ name: 'Rowan Vale', color: DEFAULT_PROFILE.color });
    await w.get('[data-test="name-prompt-ok"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    expect(loadTrackPromptSeen(s)).toBe(true);
    await w.get('[data-test="track-changes"]').trigger('click');
    await w.get('[data-test="track-changes"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    w.unmount();
  });

  it('opens inline name & color from the prompt change action', async () => {
    const s = store();
    const { w } = await mountedEditor({ storage: s, computerName: 'Writer' });
    await w.get('[data-test="track-changes"]').trigger('click');
    await w.get('[data-test="name-prompt-change"]').trigger('click');
    expect(w.find('[data-test="settings-name-color"]').exists()).toBe(true);
    await w.get('[data-test="settings-cancel"]').trigger('click');
    expect(w.find('[data-test="settings-name-color"]').exists()).toBe(false);
    expect(loadTrackPromptSeen(s)).toBe(true);
    w.unmount();
  });

  it('uses token-backed track toggle in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const { w } = await mountedEditor({ storage: store() });
      const t = w.get('[data-test="track-changes"]');
      expect(t.classes()).toContain('sh-track');
      await t.trigger('click');
      expect(t.attributes('aria-pressed')).toBe('true');
      w.unmount();
    }
  });

  it('does not re-seed an existing saved profile', () => {
    const s = store();
    saveProfile({ name: 'Kept Name', color: 5 }, s);
    expect(seedProfileForTracking('Other', s)).toEqual({ name: 'Kept Name', color: 5 });
  });

  it('restores tracking without the prompt when it was already seen', async () => {
    const s = store({
      [TRACKING_KEY]: '1',
      [TRACK_PROMPT_SEEN_KEY]: '1',
      [PROFILE_KEY]: JSON.stringify({ name: 'Saved', color: 2 }),
    });
    const { w } = await mountedEditor({ storage: s });
    expect(w.get('[data-test="track-changes"]').attributes('aria-pressed')).toBe('true');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    w.unmount();
  });
});
