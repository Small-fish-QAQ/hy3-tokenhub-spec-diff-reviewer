#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'web');
const files = ['index.html', 'app.js', 'styles.css'];
let bytes = 0;
const contents = new Map();

for (const file of files) {
  const target = path.join(root, file);
  const content = fs.readFileSync(target, 'utf8');
  if (!content.trim()) throw new Error(`Browser asset is empty: ${file}`);
  contents.set(file, content);
  bytes += Buffer.byteLength(content, 'utf8');
}

const html = contents.get('index.html');
const script = contents.get('app.js');
if (!html.includes('src="/app.js"') || !html.includes('href="/styles.css"')) {
  throw new Error('Browser entrypoint must reference the fixed same-origin script and stylesheet.');
}
if (/<script(?![^>]*\bsrc=)/i.test(html) || /<style\b/i.test(html)) {
  throw new Error('Inline browser code would violate the server Content Security Policy.');
}
if (/apiKey|authorization|tokenhub_api_key/i.test(script)) {
  throw new Error('Client bundle must not contain credential fields.');
}

process.stdout.write(`Browser static bundle verified: ${files.length} files, ${bytes} bytes.\n`);
