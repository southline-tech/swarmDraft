/** Editor bot role templates (#248): required docs exist with standard sections. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const templatesDir = resolve(repoRoot, 'docs/bot-templates');

const ROLE_FILES = [
  'line.md',
  'continuity.md',
  'developmental.md',
  'dialogue.md',
  'drafter.md',
  'lead-orchestrator.md',
] as const;

const REQUIRED_HEADINGS = ['Role', 'Workflow', 'Pairing'] as const;

function readTemplate(name: (typeof ROLE_FILES)[number]): string {
  return readFileSync(resolve(templatesDir, name), 'utf8');
}

describe('Editor bot templates (#248)', () => {
  it('includes an index README in docs/bot-templates', () => {
    const readme = readFileSync(resolve(templatesDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/Editor bot templates/i);
    expect(readme).toMatch(/docs\/bot-templates|\.\/line\.md/);
    expect(readme).toMatch(/#233/);
    expect(readme).toMatch(/#195/);
  });

  for (const file of ROLE_FILES) {
    describe(file, () => {
      it('exists and includes Role, Workflow, and Pairing sections', () => {
        const body = readTemplate(file);
        for (const heading of REQUIRED_HEADINGS) {
          expect(body, `missing ## ${heading} in ${file}`).toMatch(
            new RegExp(`^##\\s+${heading}\\s*$`, 'm'),
          );
        }
      });

      it('states suggest-only workflow and links setup docs', () => {
        const body = readTemplate(file);
        expect(body.toLowerCase()).toMatch(/suggest/);
        expect(body.toLowerCase()).toMatch(/never paste|do not paste edits/);
        expect(body).toMatch(/bot-setup-prompt\.md/);
      });
    });
  }

  it('bot setup doc lists send_feedback (#208)', () => {
    const setup = readFileSync(resolve(repoRoot, 'docs/bot-setup-prompt.md'), 'utf8');
    expect(setup).toMatch(/send_feedback/);
    expect(setup).toMatch(/4000/);
    expect(setup).toMatch(/once per agent per day/i);
  });

  for (const file of ROLE_FILES) {
    it(`${file} documents send_feedback batching (#208)`, () => {
      const body = readTemplate(file);
      expect(body).toMatch(/send_feedback/);
      expect(body).toMatch(/4000/);
    });
  }
});
