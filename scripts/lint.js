#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'hy3_showcase.js')];
for (const directory of ['lib', 'scripts', 'test', 'web']) {
  collectJavaScript(path.join(root, directory), files);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
}

function collectJavaScript(directory, output) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScript(target, output);
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(target);
  }
}
