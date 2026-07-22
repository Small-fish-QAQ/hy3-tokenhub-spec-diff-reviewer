#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const markdownFiles = [path.join(root, 'README.md')];
collect(path.join(root, 'docs'), markdownFiles);
const errors = [];
let localTargets = 0;

for (const file of markdownFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s+/, 1)[0].replace(/^<|>$/g, '');
    if (!target || /^(?:https?:\/\/|mailto:|#)/.test(target)) continue;
    localTargets += 1;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split('#', 1)[0]));
    if (path.relative(root, resolved).startsWith('..')) {
      errors.push(`${path.relative(root, file)}: local link escapes repository: ${target}`);
    } else if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(root, file)}: missing local target: ${target}`);
    }
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
    if (/versioned/i.test(match[1]) && /\/(?:blob|raw)\/main\//.test(match[2])) {
      errors.push(`${path.relative(root, file)}: mutable main link labelled versioned`);
    }
  }
}

if (errors.length) {
  process.stderr.write(`Documentation checks failed (${errors.length}):\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Documentation checks passed: ${markdownFiles.length} Markdown files, ${localTargets} local targets.\n`);
}

function collect(directory, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target, output);
    else if (entry.isFile() && entry.name.endsWith('.md')) output.push(target);
  }
}
