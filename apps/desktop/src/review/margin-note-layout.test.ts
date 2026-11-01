import { describe, expect, it } from 'vitest';
import {
  MARGIN_CONNECTOR_FADE_PX,
  MARGIN_NOTE_GAP_PX,
  stackMarginNoteTops,
} from './margin-note-layout';

describe('margin note layout (#212)', () => {
  it('keeps an 8px gap when ideals overlap', () => {
    const items = [
      { key: 'a', idealTop: 10, height: 40 },
      { key: 'b', idealTop: 12, height: 40 },
    ];
    const out = stackMarginNoteTops(items, null);
    expect(out[0]!.top).toBe(10);
    expect(out[1]!.top).toBe(10 + 40 + MARGIN_NOTE_GAP_PX);
  });

  it('places the selected card at idealTop and pushes later cards down', () => {
    const items = [
      { key: 'a', idealTop: 0, height: 30 },
      { key: 'b', idealTop: 5, height: 30 },
      { key: 'c', idealTop: 10, height: 30 },
    ];
    const out = stackMarginNoteTops(items, 'b');
    expect(out[1]!.top).toBe(5);
    expect(out[2]!.top).toBeGreaterThanOrEqual(out[1]!.top + 30 + MARGIN_NOTE_GAP_PX);
  });

  it('marks nudged when top drifts more than the connector fade threshold', () => {
    const items = [
      { key: 'a', idealTop: 0, height: 40 },
      { key: 'b', idealTop: 4, height: 40 },
    ];
    const out = stackMarginNoteTops(items, null);
    expect(out[1]!.top - out[1]!.idealTop).toBeGreaterThan(MARGIN_CONNECTOR_FADE_PX);
    expect(out[1]!.nudged).toBe(true);
    expect(out[0]!.nudged).toBe(false);
  });
});
