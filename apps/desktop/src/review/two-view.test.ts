import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import type { StoredManuscript, UpdatesSince } from '../backend';

const fx = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../fixtures/mcp/live-agent-updates.json'), 'utf8'),
) as { stored: StoredManuscript; live: UpdatesSince };
const one = fx.stored.sections[0]!;

/** Two views of one section, kept in sync, then a bot suggestion arriving on view A. */
async function twoViews() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, Uint8Array.from(one.state));
  Y.applyUpdate(b, Uint8Array.from(one.state));
  a.on('update', (u: Uint8Array, o: unknown) => o !== 'peer' && Y.applyUpdate(b, u, 'peer'));
  b.on('update', (u: Uint8Array, o: unknown) => o !== 'peer' && Y.applyUpdate(a, u, 'peer'));
  const wa = mount(ManuscriptEditor, { props: { doc: a }, attachTo: document.body });
  const wb = mount(ManuscriptEditor, { props: { doc: b }, attachTo: document.body });
  await flushPromises();
  const bot = new Y.Doc();
  Y.applyUpdate(bot, Uint8Array.from(one.state));
  const sv = Y.encodeStateVector(bot);
  for (const u of fx.live.updates)
    if (u.docId === one.docId) Y.applyUpdate(bot, Uint8Array.from(u.update));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(bot, sv), 'bot');
  await flushPromises();
  return { wa, wb };
}
const items = (w: ReturnType<typeof mount>) => w.findAll('[data-test=item]');
const text = (w: ReturnType<typeof mount>) => w.find('.tiptap').text();

describe('review panel across two views (RAD-258)', () => {
  for (const decision of ['accept', 'reject'] as const)
    it(`${decision} from the panel on view A leaves view B identical`, async () => {
      const { wa, wb } = await twoViews();
      const n = items(wa).length;
      expect(n).toBeGreaterThan(0);
      expect(items(wb)).toHaveLength(n);
      expect(text(wb)).toBe(text(wa));
      const before = text(wa);

      await items(wa)[0]!.find(`[data-test=${decision}]`).trigger('click');
      await flushPromises();
      expect(items(wa)).toHaveLength(n - 1);
      expect(items(wb)).toHaveLength(n - 1);
      expect(text(wb)).toBe(text(wa));
      expect(text(wa)).not.toBe(before);
      expect(wb.find('.tiptap').html()).toBe(wa.find('.tiptap').html());
      wa.unmount();
      wb.unmount();
    });
});
