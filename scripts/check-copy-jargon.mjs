#!/usr/bin/env node
/**
 * Writer-facing copy must not use banned jargon (#34).
 * Terms: docs/copy-deck-banned.txt (comments and blank lines ignored).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const bannedPath = join(repoRoot, 'docs/copy-deck-banned.txt');

const BANNED = readFileSync(bannedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const COPY_DECK = join(repoRoot, 'apps/desktop/src/copy-deck.ts');

/** Design / evidence previews — not shipped writer UI. */
const SKIP_VUE = [/[/\\]evidence[/\\]/, /ShellsPreview\.vue$/, /PreviewWorkspace\.vue$/];

function walkVue(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkVue(path, out);
    else if (name.endsWith('.vue')) out.push(path);
  }
  return out;
}

function rel(p) {
  return relative(repoRoot, p);
}

function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripLineComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function stripComments(text) {
  return stripLineComments(stripBlockComments(text));
}

function extractVueTemplate(vueText) {
  const m = vueText.match(/<template[^>]*>([\s\S]*)<\/template>/i);
  return m ? m[1] : '';
}

function findBanned(content, file) {
  const hits = [];
  for (const term of BANNED) {
    if (term === '.docx') {
      let idx = content.indexOf(term);
      while (idx !== -1) {
        hits.push({ file, term, index: idx });
        idx = content.indexOf(term, idx + term.length);
      }
      continue;
    }
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    let m;
    while ((m = re.exec(content)) !== null) {
      hits.push({ file, term, index: m.index });
    }
  }
  return hits;
}

/** Writer copy lives in copy-deck.ts; Vue templates may still bind deck strings. */
const scanTargets = [{ path: COPY_DECK, content: stripComments(readFileSync(COPY_DECK, 'utf8')) }];

const vueRoot = join(repoRoot, 'apps/desktop/src');
for (const vue of walkVue(vueRoot)) {
  if (SKIP_VUE.some((re) => re.test(vue))) continue;
  const raw = readFileSync(vue, 'utf8');
  const template = extractVueTemplate(raw);
  if (template) scanTargets.push({ path: vue, content: template });
}

const allHits = [];
for (const { path, content } of scanTargets) {
  allHits.push(...findBanned(content, path));
}

if (allHits.length) {
  console.error('Banned jargon in writer-facing copy:\n');
  for (const h of allHits) {
    console.error(`  ${rel(h.file)}: "${h.term}"`);
  }
  process.exit(1);
}

console.log(`copy jargon OK (${scanTargets.length} files, ${BANNED.length} banned terms)`);
