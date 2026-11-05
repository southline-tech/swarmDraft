#!/usr/bin/env node
/** Build a ~360-chapter synthetic .docx for import progress evidence (#299). */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
const require = createRequire(resolvePath('packages/docx/package.json'));
const { strToU8, zipSync } = require('fflate');

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'large-synthetic.docx');

let body = '';
for (let ch = 1; ch <= 360; ch++) {
  body += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter ${ch}</w:t></w:r></w:p>`;
  for (let p = 0; p < 55; p++) {
    let text = `Ch${ch} p${p} `;
    for (let i = 0; i < 120; i++) {
      text += String.fromCharCode(65 + ((ch * 13 + p * 7 + i) % 26));
    }
    body += `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  }
}
const xml = `<w:document ${NS}><w:body>${body}<w:p><w:r><w:t>END MARKER</w:t></w:r></w:p></w:body></w:document>`;
const bytes = zipSync({ 'word/document.xml': strToU8(xml) });
writeFileSync(out, bytes);
console.log(JSON.stringify({ path: out, bytes: bytes.length, chapters: 360 }));
