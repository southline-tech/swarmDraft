import { describe, expect, it } from 'vitest';
import { formatChangeSummary, PARAGRAPH_STYLE_TARGET } from './format-change';

describe('formatChangeSummary (#160)', () => {
  it('describes inline toggles', () => {
    expect(formatChangeSummary('bold', '0', '1')).toBe('Add bold');
    expect(formatChangeSummary('italic', '1', '0')).toBe('Remove italic');
  });

  it('describes paragraph style changes', () => {
    expect(formatChangeSummary(PARAGRAPH_STYLE_TARGET, 'body', 'centered')).toBe('Body → Centered');
  });
});
