import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/brand', () => ({ PRODUCT_NAME: 'DummyName' }));

describe('mapError uses the product name constant', () => {
  it('puts PRODUCT_NAME in every card that names the app', async () => {
    const { mapError } = await import('./map-error');
    expect(mapError('not a valid .docx').message).toContain('DummyName');
    expect(mapError('access is denied').title).toContain('DummyName');
    expect(mapError('x', 'save').message).toContain('DummyName');
    for (const c of ['not a valid .docx', 'access is denied', 'x']) {
      expect(JSON.stringify(mapError(c, 'save'))).not.toContain('coAuthor');
    }
  });
});
