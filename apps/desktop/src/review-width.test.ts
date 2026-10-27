import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #90: the open review column must have a fixed width so its contents can't widen it over the
// page, and it narrows to 320px below 1200px. Layout isn't computed in jsdom, so these check the
// shipped rules (the widths were measured in a real browser at 1024/1199/1280/1440px).
const sfc = readFileSync(resolve(__dirname, 'ManuscriptEditor.vue'), 'utf8');
const css = sfc.slice(sfc.indexOf('<style'));
const rule = (body: string, sel: string) => {
  const i = body.indexOf(`${sel} {`);
  return i < 0 ? null : body.slice(i, body.indexOf('}', i));
};

describe('review panel width (#90)', () => {
  it('the open review column has a fixed 400px token width', () => {
    const r = rule(css, '.manuscript-editor .review:not(.review--collapsed)');
    expect(r).toContain('width: var(--ct-panel-w)');
  });

  it('its children fill the column instead of setting their own width', () => {
    const r = rule(css, '.manuscript-editor .review:not(.review--collapsed) > *');
    expect(r).toContain('width: 100%');
    expect(r).toContain('min-width: 0');
  });

  it('narrows to 320px below 1200px', () => {
    const m = css.indexOf('@media (max-width: 1199.98px)');
    expect(m).toBeGreaterThan(-1);
    const r = rule(css.slice(m), '.manuscript-editor .review:not(.review--collapsed)');
    expect(r).toContain('width: var(--ct-panel-w-narrow)');
  });

  it('the collapsed rail is exempt from the fixed width', () => {
    expect(sfc).toMatch(/class="review"\s+:class="\{ 'review--collapsed': collapsed \}"/);
  });
});
