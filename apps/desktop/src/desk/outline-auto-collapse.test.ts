import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import {
  deskNeeded,
  MARGIN_NOTES_W,
  PAGE_GUTTER,
  PAGE_MIN_W,
  useOutlineAutoCollapse,
} from './outline-auto-collapse';
import {
  forcedDeskNeeded,
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
