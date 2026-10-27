import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import {
  deskNeeded,
  MARGIN_NOTES_W,
  PAGE_GUTTER,
  PAGE_MIN_W,
  useOutlineAutoCollapse,
} from './outline-auto-collapse';
import {
  forcedDeskNeeded,
  OUTLINE_ROOM,
  forcedPageNarrow,
  PAGE_FORCED_MIN_W,
  toastPlacement,
} from './outline-auto-collapse';

const narrow = { reviewShown: true, deskWidth: deskNeeded(false) - 1, marginNotes: false };
const wide = { reviewShown: true, deskWidth: 900, marginNotes: false };
const closed = { reviewShown: false, deskWidth: 900, marginNotes: false };

function setup() {
  const nav = ref(true);
  return { nav, ...useOutlineAutoCollapse(nav) };
}

describe('outline auto-collapse (#92)', () => {
  it('closes the outline while the review panel shows and the page would go below 440px', () => {
    const a = setup();
    a.update(narrow);
    expect(a.nav.value).toBe(false);
    expect(a.autoClosed.value).toBe(true);
  });

  it('a hand toggle while the review panel is closed does not stop a later auto-close (#93)', () => {
    const a = setup();
    a.update(closed);
    a.toggleByHand(); // close Chapters
    a.toggleByHand(); // and open it again, panel still closed
    expect(a.manual.value).toBe(false);
    a.update(narrow); // now open the review panel on a narrow desk
    expect(a.nav.value).toBe(false);
    expect(a.autoClosed.value).toBe(true);
  });

  it('reopens it when the review panel closes', () => {
    const a = setup();
    a.update(narrow);
    a.update(closed);
    expect(a.nav.value).toBe(true);
    expect(a.autoClosed.value).toBe(false);
  });

  it('leaves the outline alone when the page fits, exactly at the limit, or before layout', () => {
    const a = setup();
    a.update(wide);
    a.update({ ...narrow, deskWidth: deskNeeded(false) });
    a.update({ ...narrow, deskWidth: 0 });
    expect(a.nav.value).toBe(true);
    a.update({ ...narrow, reviewShown: false });
    expect(a.nav.value).toBe(true);
  });

  it('counts the margin notes in the room the page needs', () => {
    const a = setup();
    a.update({ reviewShown: true, deskWidth: deskNeeded(false) + 10, marginNotes: true });
    expect(a.nav.value).toBe(false);
  });

  it('a writer who reopens the outline by hand keeps it open; no reopen fight on close', () => {
    const a = setup();
    a.update(narrow);
    a.toggleByHand(); // writer opens it again
    expect(a.nav.value).toBe(true);
    a.update({ ...narrow, deskWidth: narrow.deskWidth - 5 }); // resize: still narrow
    expect(a.nav.value).toBe(true);
    a.update(closed);
    expect(a.nav.value).toBe(true);
  });

  it('a writer who closes the outline by hand keeps it closed after the review panel closes', () => {
    const a = setup();
    a.update(narrow);
    a.toggleByHand(); // open
    a.toggleByHand(); // close again by hand
    a.update(closed);
    expect(a.nav.value).toBe(false);
  });

  it('a manual close while the panel is open is never undone by the panel closing', () => {
    const a = setup();
    a.update(wide);
    a.toggleByHand();
    a.update(closed);
    expect(a.nav.value).toBe(false);
  });

  it('the manual choice lasts until the review panel closes, then auto-collapse applies again', async () => {
    const a = setup();
    a.update(narrow);
    a.toggleByHand();
    a.update(closed);
    await nextTick();
    a.update(narrow);
    expect(a.nav.value).toBe(false);
    expect(a.autoClosed.value).toBe(true);
  });

  it('matches the page tokens in tokens.css', () => {
    const css = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
    expect(css).toContain(`--ct-page-min-w: ${PAGE_MIN_W}px;`);
    expect(css).toContain('--ct-page-gutter: var(--ct-space-6);');
    expect(css).toContain(`--ct-space-6: ${PAGE_GUTTER}px;`);
    expect(css).toContain(`--ct-margin-notes-w: ${MARGIN_NOTES_W}px;`);
    expect(css).toContain('--ct-page-w: 576px;');
    expect(css).toContain('--ct-panel-w-narrow: 320px;');
  });
});

describe('toastPlacement (#93)', () => {
  it('centres on the desk and caps the width inside its gutters', () => {
    const l = { reviewShown: true, deskWidth: 672, marginNotes: false, deskLeft: 16 };
    expect(toastPlacement(l)).toEqual({ left: '352px', maxWidth: '624px' });
    // Right edge of a max-width toast stays left of the review panel at 688px.
    expect(352 + 624 / 2).toBeLessThanOrEqual(16 + 672);
  });
  it('falls back to CSS until the desk is measured', () => {
    expect(toastPlacement(null)).toBeNull();
    expect(toastPlacement({ reviewShown: false, deskWidth: 0, marginNotes: false })).toBeNull();
  });
});

describe('forced outline page (#96)', () => {
  it('the page is narrow (tighter padding) only when forced and under 440px', () => {
    expect(forcedPageNarrow(true, deskNeeded(false) - 1, false)).toBe(true);
    expect(forcedPageNarrow(true, deskNeeded(false), false)).toBe(false);
    expect(forcedPageNarrow(true, deskNeeded(true) - 1, true)).toBe(true);
    expect(forcedPageNarrow(false, 300, false)).toBe(false);
    expect(forcedPageNarrow(true, 0, false)).toBe(false); // not measured yet
  });
  it('the forced floor matches --ct-page-forced-min-w', () => {
    const css = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
    expect(css).toContain(`--ct-page-forced-min-w: ${PAGE_FORCED_MIN_W}px;`);
  });
});

describe('forced outline vs margin notes and focus mode (#97)', () => {
  const forcedOpen = () => {
    const a = setup();
    a.update(narrow); // auto-closed
    a.toggleByHand(); // writer forces it open
    return a;
  };
  const deskWithOutline = 368; // 1024px window, outline + review open

  it('a forced outline closes when page + notes cannot fit', () => {
    const a = forcedOpen();
    a.update({ reviewShown: true, deskWidth: deskWithOutline, marginNotes: false });
    expect(a.nav.value).toBe(true); // 320 page + gutters fits without notes
    a.update({ reviewShown: true, deskWidth: deskWithOutline, marginNotes: true });
    expect(deskWithOutline).toBeLessThan(forcedDeskNeeded(true));
    expect(a.nav.value).toBe(false);
    expect(a.forcedClosed.value).toBe(true);
  });

  it('comes back when the notes hide', () => {
    const a = forcedOpen();
    a.update({ reviewShown: true, deskWidth: deskWithOutline, marginNotes: true });
    a.update({ reviewShown: true, deskWidth: 672, marginNotes: true }); // outline closed, more room
    expect(a.nav.value).toBe(false);
    a.update({ reviewShown: true, deskWidth: 672, marginNotes: false });
    expect(a.nav.value).toBe(true);
    expect(a.forcedClosed.value).toBe(false);
  });

  it('comes back when the review panel closes', () => {
    const a = forcedOpen();
    a.update({ reviewShown: true, deskWidth: deskWithOutline, marginNotes: true });
    a.update({ reviewShown: false, deskWidth: 990, marginNotes: true });
    expect(a.nav.value).toBe(true);
  });

  it('focus mode keeps the forced choice: the outline comes back open after it', () => {
    const a = forcedOpen();
    a.update({ reviewShown: false, deskWidth: 1000, marginNotes: false, focusMode: true });
    expect(a.manual.value).toBe(true);
    a.update({ reviewShown: true, deskWidth: deskWithOutline, marginNotes: false });
    expect(a.nav.value).toBe(true);
    expect(a.manual.value).toBe(true);
  });
});

describe('notes keep a gap to the review panel (#97)', () => {
  it('the thresholds count the 16px notes gap', () => {
    expect(forcedDeskNeeded(true)).toBe(320 + 48 + 104 + 16);
    expect(forcedDeskNeeded(false)).toBe(368);
  });
  it('the CSS keeps --ct-space-4 between the notes column and the panel', () => {
    const vue = readFileSync(resolve(__dirname, '../ManuscriptEditor.vue'), 'utf8');
    expect(vue).toMatch(/\.desk > \.sh-margin \{\s*margin-right: var\(--ct-space-4\);/);
    expect(vue).toContain(
      '--ct-page-notes-room: calc(var(--ct-margin-notes-w) + var(--ct-space-4));',
    );
    const tokens = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
    expect(tokens).toContain('--ct-space-4: 16px;');
  });
});

describe('auto-closed outline and margin notes (#98)', () => {
  // 1152px window: desk 496px with the outline open, 800px with it closed (OUTLINE_ROOM 304).
  const L = (deskWidth: number, marginNotes: boolean) => ({
    reviewShown: true,
    deskWidth,
    marginNotes,
  });

  it('reopens an auto-closed outline when the notes hide and the page fits again', () => {
    const a = setup();
    a.update(L(496, false));
    a.update(L(496, true));
    expect(a.nav.value).toBe(false);
    a.update(L(800, true)); // still no room with notes: stays closed
    expect(a.nav.value).toBe(false);
    a.update(L(800, false));
    expect(a.nav.value).toBe(true);
    expect(a.autoClosed.value).toBe(false);
  });

  it('stays closed when the writer closed it by hand', () => {
    const a = setup();
    a.update(L(496, false));
    a.toggleByHand(); // writer closes it
    a.update(L(800, true));
    a.update(L(800, false));
    expect(a.nav.value).toBe(false);
  });

  it('does not open an outline the writer closed while the panel was hidden', () => {
    const a = setup();
    a.update({ reviewShown: false, deskWidth: 990, marginNotes: false });
    a.toggleByHand(); // closed by hand, panel hidden: not "manual", not auto-closed
    a.update(L(800, true));
    a.update(L(800, false));
    expect(a.nav.value).toBe(false);
  });

  it('no flicker or loop as the notes toggle: one change per toggle', () => {
    const a = setup();
    const changes: boolean[] = [];
    watch(a.nav, (v) => changes.push(v), { flush: 'sync' });
    a.update(L(496, false));
    for (let i = 0; i < 3; i++) {
      a.update(L(496, true)); // notes show: closes
      a.update(L(800, true)); // the editor re-reports the wider desk: no change
      a.update(L(800, false)); // notes hide: reopens
      a.update(L(496, false)); // the editor re-reports the narrower desk: no change
    }
    expect(changes).toEqual([false, true, false, true, false, true]);
  });
});

describe('no room for the outline while notes show (#98)', () => {
  // 1024px window, review panel + notes: desk 672px with the outline closed, 368px open.
  const at1024 = { reviewShown: true, deskWidth: 672, marginNotes: true };

  it('Chapters signals no room instead of opening and closing again', () => {
    const a = setup();
    a.nav.value = false;
    a.update(at1024);
    a.toggleByHand();
    expect(a.nav.value).toBe(false);
    expect(a.noRoom.value).toBe(1);
    expect(a.manual.value).toBe(false);
  });

  it('opens normally when the notes are hidden or there is room', () => {
    const a = setup();
    a.nav.value = false;
    a.update({ ...at1024, marginNotes: false });
    a.toggleByHand();
    expect(a.nav.value).toBe(true);
    expect(a.noRoom.value).toBe(0);
  });

  it('openByHand ("Hide notes") opens as the writer\'s choice and holds without notes', () => {
    const a = setup();
    a.nav.value = false;
    a.update(at1024);
    a.openByHand();
    expect(a.nav.value).toBe(true);
    expect(a.manual.value).toBe(true);
    a.update({ reviewShown: true, deskWidth: 368, marginNotes: false });
    expect(a.nav.value).toBe(true);
  });

  it('OUTLINE_ROOM matches the 18rem outline column plus the gap-4 workspace gap', () => {
    const app = readFileSync(resolve(__dirname, '../App.vue'), 'utf8');
    expect(app).toContain("'grid-cols-[18rem_1fr]'");
    expect(app).toMatch(/class="workspace grid gap-4/);
    expect(OUTLINE_ROOM).toBe(18 * 16 + 16);
  });
});
