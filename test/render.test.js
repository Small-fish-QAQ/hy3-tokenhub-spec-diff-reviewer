'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { validateOutputPath } = require('../lib/diff_review');
const { deriveJsonOutputPath, publishReviewOutputs } = require('../lib/render');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hy3-render-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Markdown and JSON/provenance sidecar are staged then published together', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdownPath = path.join(directory, 'nested', 'review.md');
  const saved = await publishReviewOutputs(markdownPath, '# Review\n', '{"ok":true}\n');
  assert.equal(saved.markdownPath, markdownPath);
  assert.equal(saved.jsonPath, path.join(directory, 'nested', 'review.json'));
  assert.equal(await fs.readFile(saved.markdownPath, 'utf8'), '# Review\n');
  assert.equal(await fs.readFile(saved.jsonPath, 'utf8'), '{"ok":true}\n');
  assert.deepEqual((await fs.readdir(path.dirname(markdownPath))).sort(), ['review.json', 'review.md']);
});

test('an existing output bundle is atomically replaced without stale backup files', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdownPath = path.join(directory, 'review.md');
  const jsonPath = deriveJsonOutputPath(markdownPath);
  await fs.writeFile(markdownPath, 'old markdown');
  await fs.writeFile(jsonPath, 'old json');
  await publishReviewOutputs(markdownPath, 'new markdown', 'new json');
  assert.equal(await fs.readFile(markdownPath, 'utf8'), 'new markdown');
  assert.equal(await fs.readFile(jsonPath, 'utf8'), 'new json');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['review.json', 'review.md']);
});

test('publication failure rolls both files back and removes every temporary file', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdownPath = path.join(directory, 'review.md');
  const jsonPath = deriveJsonOutputPath(markdownPath);
  await fs.writeFile(markdownPath, 'old markdown');
  await fs.writeFile(jsonPath, 'old json');
  let tempRenames = 0;
  const fsImpl = {
    mkdir: fs.mkdir,
    open: fs.open,
    rm: fs.rm,
    async rename(source, destination) {
      if (source.endsWith('.tmp')) {
        tempRenames += 1;
        if (tempRenames === 2) {
          const error = new Error('synthetic second publication failure');
          error.code = 'EIO';
          throw error;
        }
      }
      return fs.rename(source, destination);
    }
  };
  await assert.rejects(
    publishReviewOutputs(markdownPath, 'new markdown', 'new json', { fsImpl, suffix: 'rollback' }),
    /Unable to publish the review output bundle/
  );
  assert.equal(await fs.readFile(markdownPath, 'utf8'), 'old markdown');
  assert.equal(await fs.readFile(jsonPath, 'utf8'), 'old json');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['review.json', 'review.md']);
});

test('output validation rejects a JSON sidecar that would overwrite an input', async (t) => {
  const directory = await temporaryDirectory(t);
  const specPath = path.join(directory, 'review.json');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specPath, 'R1: Keep input.');
  await fs.writeFile(diffPath, 'diff');
  await assert.rejects(validateOutputPath({
    spec: specPath,
    diff: diffPath,
    git: false,
    output: path.join(directory, 'review.md')
  }), /must not overwrite/);
});
