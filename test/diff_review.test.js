'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { FriendlyError } = require('../lib/tokenhub');
const {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_DIFF_BYTES,
  MAX_SPEC_BYTES,
  loadDiffReviewInputs,
  parseDiffReviewArgs,
  readStagedDiff,
  validateOutputPath,
  validateInputText,
  writeReportAtomic
} = require('../lib/diff_review');

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hy3-diff-review-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function assertFriendlyError(error, pattern) {
  assert.ok(error instanceof FriendlyError);
  assert.match(error.message, pattern);
  return true;
}

test('parseDiffReviewArgs applies streaming and timeout defaults', () => {
  assert.deepEqual(parseDiffReviewArgs(['--spec', 'issue.md', '--diff', 'change.diff']), {
    stream: true,
    git: false,
    help: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    spec: 'issue.md',
    diff: 'change.diff'
  });
});

test('parseDiffReviewArgs supports output, timeout, and --no-stream', () => {
  assert.deepEqual(
    parseDiffReviewArgs([
      '--spec',
      'issue.md',
      '--diff',
      'change.diff',
      '--output',
      'reports/review.md',
      '--timeout',
      '45',
      '--no-stream'
    ]),
    {
      stream: false,
      git: false,
      help: false,
      timeoutSeconds: 45,
      spec: 'issue.md',
      diff: 'change.diff',
      output: 'reports/review.md'
    }
  );
});

test('parseDiffReviewArgs accepts staged Git and stdin diff sources', () => {
  assert.deepEqual(parseDiffReviewArgs(['--spec', 'issue.md', '--git']), {
    stream: true,
    git: true,
    help: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    spec: 'issue.md'
  });

  assert.equal(
    parseDiffReviewArgs(['--spec', 'issue.md', '--diff', '-']).diff,
    '-'
  );
});

test('parseDiffReviewArgs lets --help stand alone without required inputs', () => {
  assert.equal(parseDiffReviewArgs(['--help']).help, true);
});

test('parseDiffReviewArgs rejects a missing --spec', () => {
  assert.throws(
    () => parseDiffReviewArgs(['--diff', 'change.diff']),
    (error) => assertFriendlyError(error, /Missing required option: --spec/)
  );
});

test('parseDiffReviewArgs rejects conflicting file and staged Git sources', () => {
  assert.throws(
    () => parseDiffReviewArgs(['--spec', 'issue.md', '--diff', 'change.diff', '--git']),
    (error) => assertFriendlyError(error, /Choose exactly one diff source/)
  );
});

test('parseDiffReviewArgs rejects a missing diff source', () => {
  assert.throws(
    () => parseDiffReviewArgs(['--spec', 'issue.md']),
    (error) => assertFriendlyError(error, /Missing diff source/)
  );
});

test('parseDiffReviewArgs validates timeout as a bounded whole number', async (t) => {
  for (const value of ['0', '-1', '1.5', 'abc', '3601']) {
    await t.test(value, () => {
      assert.throws(
        () =>
          parseDiffReviewArgs([
            '--spec',
            'issue.md',
            '--diff',
            'change.diff',
            '--timeout',
            value
          ]),
        (error) => assertFriendlyError(error, /--timeout must be a whole number from 1 to 3600/)
      );
    });
  }
});

test('parseDiffReviewArgs rejects missing option values and duplicate sources', () => {
  assert.throws(
    () => parseDiffReviewArgs(['--spec', '--git']),
    (error) => assertFriendlyError(error, /--spec requires a value/)
  );
  assert.throws(
    () =>
      parseDiffReviewArgs([
        '--spec',
        'issue.md',
        '--diff',
        'one.diff',
        '--diff',
        'two.diff'
      ]),
    (error) => assertFriendlyError(error, /--diff may only be provided once/)
  );
});

test('validateOutputPath rejects --output identical to the specification path', async (t) => {
  const directory = await makeTemporaryDirectory(t);

  await assert.rejects(
    validateOutputPath(
      {
        spec: 'issue.md',
        diff: 'change.diff',
        output: 'issue.md',
        git: false
      },
      { cwd: directory }
    ),
    (error) => assertFriendlyError(error, /must not overwrite the specification or diff input/)
  );
});

test('validateOutputPath rejects --output identical to a file diff path', async (t) => {
  const directory = await makeTemporaryDirectory(t);

  await assert.rejects(
    validateOutputPath(
      {
        spec: 'issue.md',
        diff: 'change.diff',
        output: 'change.diff',
        git: false
      },
      { cwd: directory }
    ),
    (error) => assertFriendlyError(error, /must not overwrite the specification or diff input/)
  );
});

test('validateOutputPath detects relative and absolute forms of the same path', async (t) => {
  const directory = await makeTemporaryDirectory(t);

  await assert.rejects(
    validateOutputPath(
      {
        spec: 'issue.md',
        diff: 'change.diff',
        output: path.resolve(directory, 'issue.md'),
        git: false
      },
      { cwd: directory }
    ),
    (error) => assertFriendlyError(error, /must not overwrite the specification or diff input/)
  );
});

test('validateOutputPath compares Windows paths case-insensitively', async () => {
  const fsImpl = {
    async realpath() {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
  };

  await assert.rejects(
    validateOutputPath(
      {
        spec: 'C:\\Work\\Repo\\Issue.md',
        diff: 'C:\\Work\\Repo\\Change.diff',
        output: 'c:\\work\\repo\\ISSUE.MD',
        git: false
      },
      {
        cwd: 'C:\\Work\\Repo',
        fsImpl,
        pathImpl: path.win32,
        platform: 'win32'
      }
    ),
    (error) => assertFriendlyError(error, /must not overwrite the specification or diff input/)
  );
});

test('validateOutputPath detects a practical realpath alias collision', async () => {
  const aliasTargets = new Map([
    ['/workspace/issue-link.md', '/real/artifacts/issue.md'],
    ['/workspace/report-link.md', '/real/artifacts/issue.md']
  ]);
  const fsImpl = {
    async realpath(filePath) {
      if (aliasTargets.has(filePath)) {
        return aliasTargets.get(filePath);
      }
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
  };

  await assert.rejects(
    validateOutputPath(
      {
        spec: 'issue-link.md',
        diff: 'change.diff',
        output: 'report-link.md',
        git: false
      },
      {
        cwd: '/workspace',
        fsImpl,
        pathImpl: path.posix,
        platform: 'linux'
      }
    ),
    (error) => assertFriendlyError(error, /must not overwrite the specification or diff input/)
  );
});

test('validateOutputPath allows overwriting an existing unrelated report', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  const reportPath = path.join(directory, 'review.md');
  await fs.writeFile(specificationPath, 'A requirement');
  await fs.writeFile(diffPath, '+change');
  await fs.writeFile(reportPath, 'An earlier report');

  await validateOutputPath({
    spec: specificationPath,
    diff: diffPath,
    output: reportPath,
    git: false
  });

  const replacement = '# Replacement report\n';
  await writeReportAtomic(reportPath, replacement, { suffix: 'overwrite' });
  assert.equal(await fs.readFile(reportPath, 'utf8'), replacement);
});

test('validateOutputPath does not treat stdin or staged Git as file-path collisions', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  await fs.writeFile(specificationPath, 'A requirement');

  await validateOutputPath(
    {
      spec: specificationPath,
      diff: '-',
      output: '-',
      git: false
    },
    { cwd: directory }
  );

  await validateOutputPath(
    {
      spec: specificationPath,
      git: true,
      output: path.join(directory, 'change.diff')
    },
    { cwd: directory }
  );
});

test('loadDiffReviewInputs reads ordinary files', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specificationPath, '# Requirement\nReturn JSON.\n');
  await fs.writeFile(diffPath, 'diff --git a/a.js b/a.js\n+return {};\n');

  assert.deepEqual(
    await loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    {
      specification: '# Requirement\nReturn JSON.\n',
      diff: 'diff --git a/a.js b/a.js\n+return {};\n'
    }
  );
});

test('loadDiffReviewInputs reads --diff - from stdin', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  await fs.writeFile(specificationPath, 'A requirement');

  const inputs = await loadDiffReviewInputs(
    { spec: specificationPath, diff: '-', git: false },
    { stdin: Readable.from(['diff --git a/a b/a\n', '+change\n']) }
  );

  assert.equal(inputs.diff, 'diff --git a/a b/a\n+change\n');
});

test('loadDiffReviewInputs rejects an empty specification', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specificationPath, ' \r\n\t');
  await fs.writeFile(diffPath, '+change\n');

  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => assertFriendlyError(error, /Specification is empty/)
  );
});

test('loadDiffReviewInputs rejects an empty diff', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specificationPath, 'A requirement');
  await fs.writeFile(diffPath, '\n\t');

  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => assertFriendlyError(error, /Diff is empty/)
  );
});

test('loadDiffReviewInputs reports missing specification and diff files clearly', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');

  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => assertFriendlyError(error, /Specification file not found/)
  );

  await fs.writeFile(specificationPath, 'A requirement');
  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => assertFriendlyError(error, /Diff file not found/)
  );
});

test('loadDiffReviewInputs enforces the specification byte limit', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specificationPath, Buffer.alloc(MAX_SPEC_BYTES + 1, 's'));
  await fs.writeFile(diffPath, '+change\n');

  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => {
      assertFriendlyError(error, /Specification exceeds the local showcase limit of 512 KiB/);
      assert.match(error.message, /not a TokenHub service limit/);
      return true;
    }
  );
});

test('loadDiffReviewInputs enforces the diff byte limit', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  const diffPath = path.join(directory, 'change.diff');
  await fs.writeFile(specificationPath, 'A requirement');
  await fs.writeFile(diffPath, Buffer.alloc(MAX_DIFF_BYTES + 1, 'd'));

  await assert.rejects(
    loadDiffReviewInputs({ spec: specificationPath, diff: diffPath, git: false }),
    (error) => assertFriendlyError(error, /Diff exceeds the local showcase limit of 512 KiB/)
  );
});

test('validateInputText measures UTF-8 bytes rather than JavaScript characters', () => {
  assert.throws(
    () => validateInputText('\u754c'.repeat(Math.floor(MAX_SPEC_BYTES / 3) + 1), 'Specification', MAX_SPEC_BYTES),
    (error) => assertFriendlyError(error, /Specification exceeds the local showcase limit/)
  );
});

test('readStagedDiff invokes only git diff --cached with safe display flags', async () => {
  let invocation;
  const staged = await readStagedDiff((command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null, 'diff --git a/a.js b/a.js\n');
  }, 'C:\\workspace');

  assert.equal(staged, 'diff --git a/a.js b/a.js\n');
  assert.equal(invocation.command, 'git');
  assert.deepEqual(invocation.args, [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color'
  ]);
  assert.equal(invocation.options.cwd, 'C:\\workspace');
  assert.equal(invocation.options.windowsHide, true);
});

test('readStagedDiff prefers sanitized Git stderr over the child-process error message', async () => {
  const stderrSecret = 'git-stderr-secret';
  const childError = new Error('fallback child-process message');

  await assert.rejects(
    readStagedDiff((_command, _args, _options, callback) => {
      callback(childError, '', `fatal: Bearer ${stderrSecret}\n`);
    }, 'C:\\workspace'),
    (error) => {
      assertFriendlyError(error, /Unable to read the staged Git diff: fatal:/);
      assert.match(error.message, /Bearer \[redacted\]/);
      assert.equal(error.message.includes(stderrSecret), false);
      assert.equal(error.message.includes('fallback child-process message'), false);
      return true;
    }
  );
});

test('loadDiffReviewInputs gives recovery guidance for an empty staged Git diff', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const specificationPath = path.join(directory, 'issue.md');
  await fs.writeFile(specificationPath, 'A requirement');

  const execFileImpl = (_command, _args, _options, callback) => callback(null, '  \r\n');
  await assert.rejects(
    loadDiffReviewInputs(
      { spec: specificationPath, git: true },
      { execFileImpl, cwd: directory }
    ),
    (error) => {
      assertFriendlyError(error, /staged Git diff is empty/);
      assert.match(error.message, /Stage changes/);
      assert.match(error.message, /--diff <path>/);
      assert.match(error.message, /--diff -/);
      return true;
    }
  );
});

test('writeReportAtomic creates parents and publishes only the completed report', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'nested', 'review.md');
  const report = '# Hy3 PR Readiness Report\n\nReady after fixes\n';

  const savedPath = await writeReportAtomic(outputPath, report, { suffix: 'deterministic' });

  assert.equal(savedPath, path.resolve(outputPath));
  assert.equal(await fs.readFile(outputPath, 'utf8'), report);
  assert.deepEqual(await fs.readdir(path.dirname(outputPath)), ['review.md']);
});
