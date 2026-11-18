import { describe, expect, it, vi } from 'vitest';
import {
  collectManuscriptMarkAnchors,
  pickActiveManuscriptMark,
  scrollBehavior,
  scrollElementBesideObstacle,
  scrollListRowToTop,
  scrollSectionAnchorToTop,
  type ManuscriptMarkAnchor,
} from './review-scroll';
import { scopeBookChangeKey } from './review-book';

function rootAt(top: number) {
  const root = document.createElement('div');
  root.getBoundingClientRect = () =>
    ({ top, bottom: top + 400, left: 0, right: 400, width: 400, height: 400 }) as DOMRect;
  return root;
}

describe('pickActiveManuscriptMark hysteresis (#217)', () => {
  const root = rootAt(100);
  const line = 164;

  it('keeps the previous neighbor until the next mark crosses line + 8px', () => {
    const anchors: ManuscriptMarkAnchor[] = [
      { scopedKey: 'a', top: 120, el: document.createElement('ins') },
      { scopedKey: 'b', top: line + 4, el: document.createElement('ins') },
    ];
    expect(pickActiveManuscriptMark(anchors, root, 'a', 64, 8)).toBe('a');
    anchors[1]!.top = line + 8;
    expect(pickActiveManuscriptMark(anchors, root, 'a', 64, 8)).toBe('b');
  });

  it('keeps the previous neighbor when scrolling up until the upper mark is 8px above the line', () => {
    const anchors: ManuscriptMarkAnchor[] = [
      { scopedKey: 'b', top: 155, el: document.createElement('ins') },
      { scopedKey: 'a', top: 157, el: document.createElement('ins') },
    ];
    expect(pickActiveManuscriptMark(anchors, root, 'b', 64, 8)).toBe('b');
    anchors[1]!.top = line - 8;
    expect(pickActiveManuscriptMark(anchors, root, 'b', 64, 8)).toBe('a');
  });
});

describe('collectManuscriptMarkAnchors', () => {
  it('includes comment anchors with stable ids (#217 comments in sync)', () => {
    const root = document.createElement('div');
    const section = document.createElement('div');
    section.setAttribute('data-section-anchor', 'ch1');
    const mark = document.createElement('span');
    mark.className = 'comment-anchor';
    mark.setAttribute('data-id', 'c1');
    mark.getBoundingClientRect = () =>
      ({ top: 50, bottom: 60, left: 0, right: 10, width: 10, height: 10 }) as DOMRect;
    section.appendChild(mark);
    root.appendChild(section);
    root.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500, left: 0, right: 400, width: 400, height: 500 }) as DOMRect;

    const anchors = collectManuscriptMarkAnchors(root);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.scopedKey).toBe(scopeBookChangeKey('ch1', 'comment:c1'));
  });
});

describe('scrollSectionAnchorToTop (#261)', () => {
  it('adjusts only the scroll container, not the window', () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'scrollTop', { writable: true, value: 0 });
    root.getBoundingClientRect = () =>
      ({ top: 200, bottom: 800, left: 0, right: 400, width: 400, height: 600 }) as DOMRect;
    const section = document.createElement('div');
    section.getBoundingClientRect = () =>
      ({ top: 350, bottom: 400, left: 0, right: 400, width: 400, height: 50 }) as DOMRect;
    scrollSectionAnchorToTop(root, section);
    expect(root.scrollTop).toBe(150);
  });
});

describe('scrollListRowToTop', () => {
  it('offsets by sticky chapter head height + padding', () => {
    const list = document.createElement('div');
    list.scrollTop = 0;
    list.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 200, width: 200, height: 400 }) as DOMRect;
    Object.defineProperty(list, 'scrollTop', { writable: true, value: 0 });

    const group = document.createElement('section');
    group.className = 'chapter-group';
    const head = document.createElement('h3');
    head.className = 'chapter-head';
    head.getBoundingClientRect = () =>
      ({ top: 100, bottom: 124, left: 0, right: 200, width: 200, height: 24 }) as DOMRect;
    const row = document.createElement('li');
    row.getBoundingClientRect = () =>
      ({ top: 140, bottom: 180, left: 0, right: 200, width: 200, height: 40 }) as DOMRect;
    group.append(head, row);
    list.appendChild(group);

    scrollListRowToTop(list, row, 8);
    // delta = 140 - 100 - 8 - 24 = 8
    expect(list.scrollTop).toBe(8);
  });
});

function edges(top: number, right: number, bottom: number, left: number): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('scrollElementBesideObstacle (#305)', () => {
  it('moves a covered line into the open band beside the card', () => {
    const root = document.createElement('div');
    let scrollTop = 500;
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2400 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
    root.getBoundingClientRect = () => edges(40, 900, 840, 0);
    const card = edges(220, 760, 620, 200);
    const el = document.createElement('p');
    el.getBoundingClientRect = () => {
      const top = 900 - scrollTop;
      return edges(top, 700, top + 20, 220);
    };
    const before = el.getBoundingClientRect();
    expect(before.top).toBeLessThan(card.bottom);
    expect(before.bottom).toBeGreaterThan(card.top);
    scrollElementBesideObstacle(root, el, card);
    const after = el.getBoundingClientRect();
    const clear =
      after.bottom <= card.top + 1 ||
      after.top >= card.bottom - 1 ||
      after.right <= card.left + 1 ||
      after.left >= card.right - 1;
    expect(clear).toBe(true);
    expect(scrollTop).not.toBe(500);
  });

  it('leaves a line that is already beside the card', () => {
    const root = document.createElement('div');
    root.scrollTop = 40;
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
    root.getBoundingClientRect = () => edges(0, 1200, 800, 0);
    const el = document.createElement('p');
    el.getBoundingClientRect = () => edges(300, 1100, 324, 860);
    scrollElementBesideObstacle(root, el, edges(200, 700, 560, 200));
    expect(root.scrollTop).toBe(40);
  });
});

describe('scrollBehavior', () => {
  it('uses auto when prefers-reduced-motion is reduce', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(scrollBehavior()).toBe('auto');
    vi.unstubAllGlobals();
  });
});
