import { afterEach, beforeEach } from 'vitest';
import { ensureOverlayLayer } from './src/overlay/layer';

ensureOverlayLayer();

beforeEach(() => {
  ensureOverlayLayer();
});

afterEach(() => {
  ensureOverlayLayer().replaceChildren();
});
