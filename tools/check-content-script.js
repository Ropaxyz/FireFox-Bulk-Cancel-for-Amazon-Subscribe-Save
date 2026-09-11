#!/usr/bin/env node
/*
 * Pre-flight check for content-script.js.
 *
 * `node --check` is NOT sufficient here: the stylesheet lives in a template
 * literal, and a stray backtick inside a CSS comment closes it early. Node
 * happily parses the result as a tagged template, while a browser throws
 * "Uncaught SyntaxError" and never runs a single line of the extension
 * (which has happened: the panel still rendered because that DOM came from
 * the saved page). Compiling the source as a classic script catches it.
 *
 * Usage: node tools/check-content-script.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'content-script.js'), 'utf8');
let failed = false;

// 1. Parse the way a browser parses a classic <script>.
//    vm.Script compiles the source as a classic script, exactly like
//    new Function(src) did, but without evaluating a string as code -
//    which is what AMO's validator warns about. It is also stricter
//    (e.g. it rejects a top-level `return`), so it matches a content
//    script more closely than a function body does.
try {
  new vm.Script(src, { filename: 'content-script.js' });
  console.log('OK  parses as a classic script');
} catch (e) {
  failed = true;
  console.error('FAIL parse error - the extension would not run at all:', e.message);
}

// 2. No backtick inside a comment while a template literal is open.
//    A small scanner is enough: we only need to know if a comment starts
//    inside an open template literal.
function scanBackticksInComments(source) {
  const hits = [];
  let i = 0;
  let line = 1;
  let inTemplate = false;
  let inBlockComment = false;
  let inLineComment = false;
  let inString = null; // "'", '"' or null

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') {
      line++;
      inLineComment = false;
      i++;
      continue;
    }
    if (inLineComment) {
      if (ch === '`' && inTemplate) hits.push({ line, text: source.slice(i, source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i)).trim() });
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '`' && inTemplate) {
        const end = source.indexOf('\n', i);
        hits.push({ line, text: source.slice(i, end === -1 ? source.length : end).trim() });
      }
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { inString = ch; i++; continue; }
    if (ch === '`') { inTemplate = !inTemplate; i++; continue; }
    i++;
  }
  return hits;
}

const stray = scanBackticksInComments(src);
if (stray.length) {
  failed = true;
  stray.forEach((h) => {
    console.error(`FAIL line ${h.line}: backtick inside a comment while a template literal is open:`);
    console.error(`     ${h.text}`);
  });
} else {
  console.log('OK  no stray backticks in comments');
}

// 3. Shipped text must be plain ASCII with no BOM.
//    The status log was once double-encoded (UTF-8 read as cp1252 and written
//    back), which turned every emoji into sequences like "A-cents-a-euro" and
//    looked alarming in the panel.
//    Escapes like \u00fc inside regexes are fine; literal bytes are not.
for (const name of [
  'content-script.js',
  'manifest.json',
  'README.md',
  'PRIVACY.md',
  'tools/check-content-script.js',
]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 126);
  if (bom) {
    failed = true;
    console.error(`FAIL ${name}: starts with a UTF-8 BOM`);
  }
  if (nonAscii.length) {
    failed = true;
    const sample = [...new Set(nonAscii)].slice(0, 8).join(' ');
    console.error(`FAIL ${name}: ${nonAscii.length} non-ASCII character(s): ${sample}`);
  }
  if (!bom && !nonAscii.length) console.log(`OK  ${name} is plain ASCII without a BOM`);
}

// 4. Version must match the manifest.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versionMatch = src.match(/const VERSION = '([^']+)'/);
if (!versionMatch || versionMatch[1] !== manifest.version) {
  failed = true;
  console.error(
    `FAIL version mismatch: script=${versionMatch && versionMatch[1]} manifest=${manifest.version}`
  );
} else {
  console.log(`OK  version ${manifest.version} matches manifest`);
}

process.exit(failed ? 1 : 0);

