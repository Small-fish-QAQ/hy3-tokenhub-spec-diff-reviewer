'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FriendlyError } = require('../lib/tokenhub');
const {
  callModel,
  handleTopLevelError,
  loadApiKey,
  main,
  runDiffReview
} = require('../hy3_showcase');

function captureOutput() {
  let value = '';
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
        return true;
      }
    },
    read() {
      return value;
    }
  };
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hy3-cli-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runMainThroughTopLevelHandler(args, dependencies) {
  try {
    return { exitCode: await main(args, dependencies), error: null };
  } catch (error) {
    return {
      exitCode: handleTopLevelError(error, dependencies.stderr),
      error
    };
  }
}

test('general help advertises only the spec-to-diff reviewer workflow', async () => {
  const stdout = captureOutput();
  let loadedCredentials = false;
  let requested = false;

  const exitCode = await main(['--help'], {
    stdout: stdout.stream,
    stderr: captureOutput().stream,
    loadApiKey() {
      loadedCredentials = true;
      throw new Error('must not run');
    },
    requestChatCompletion() {
      requested = true;
      throw new Error('must not run');
    }
  });

  const help = stdout.read();
  assert.equal(exitCode, 0);
  assert.equal(loadedCredentials, false);
  assert.equal(requested, false);
  assert.match(help, /^Hy3 TokenHub Spec-to-Diff Reviewer$/m);
  assert.match(
    help,
    /^  node hy3_showcase\.js diff-review --spec <path> \(--diff <path> \| --diff - \| --git\) \[options\]$/m
  );
  assert.match(help, /^  diff-review  Compare a written specification with a proposed diff$/m);

  for (const command of ['chat', 'summarize', 'code-review', 'brief', 'all']) {
    assert.doesNotMatch(help, new RegExp(`^  ${command}\\b`, 'm'));
  }
});

test('removed commands are rejected before credentials or TokenHub requests', async (t) => {
  for (const command of ['chat', 'summarize', 'code-review', 'brief', 'all']) {
    await t.test(command, async () => {
      let loadedCredentials = false;
      let requested = false;

      await assert.rejects(
        main([command], {
          stdout: captureOutput().stream,
          stderr: captureOutput().stream,
          loadApiKey() {
            loadedCredentials = true;
            throw new Error('must not run');
          },
          requestChatCompletion() {
            requested = true;
            throw new Error('must not run');
          }
        }),
        (error) => {
          assert.ok(error instanceof FriendlyError);
          assert.equal(
            error.message,
            `Invalid command: ${command}. Run with --help to see available commands.`
          );
          return true;
        }
      );

      assert.equal(loadedCredentials, false);
      assert.equal(requested, false);
    });
  }
});

test('diff-review --help does not load credentials or call TokenHub', async () => {
  const stdout = captureOutput();
  let loadedCredentials = false;
  let requested = false;

  const exitCode = await main(['diff-review', '--help'], {
    stdout: stdout.stream,
    stderr: captureOutput().stream,
    loadApiKey() {
      loadedCredentials = true;
      throw new Error('must not run');
    },
    requestChatCompletion() {
      requested = true;
      throw new Error('must not run');
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(loadedCredentials, false);
  assert.equal(requested, false);
  assert.match(stdout.read(), /--diff -/);
  assert.match(stdout.read(), /default: 180/);
});

test('loadApiKey rejects a whitespace-only value without loading dotenv', () => {
  assert.throws(
    () => loadApiKey({ TOKENHUB_API_KEY: '  \r\n\t  ' }),
    (error) => {
      assert.ok(error instanceof FriendlyError);
      assert.match(error.message, /Missing TOKENHUB_API_KEY/);
      return true;
    }
  );
});

test('loadApiKey rejects the placeholder after trimming whitespace', () => {
  assert.throws(
    () => loadApiKey({ TOKENHUB_API_KEY: '  your_tokenhub_api_key_here\r\n' }),
    (error) => {
      assert.ok(error instanceof FriendlyError);
      assert.match(error.message, /Missing TOKENHUB_API_KEY/);
      return true;
    }
  );
});

test('loadApiKey returns a normalized non-placeholder key', () => {
  assert.equal(
    loadApiKey({ TOKENHUB_API_KEY: '  synthetic-normalized-key\r\n' }),
    'synthetic-normalized-key'
  );
});

test('callModel aborts on Ctrl+C, sets exit code 130, and removes its listener', async () => {
  const listenersBefore = process.rawListeners('SIGINT');
  let requestSignal;

  const pendingRequest = callModel(
    { messages: [], apiKey: 'synthetic-test-key' },
    {
      requestChatCompletion(options) {
        requestSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new FriendlyError('Synthetic offline cancellation.')),
            { once: true }
          );
        });
      }
    }
  );

  const installedListeners = process
    .rawListeners('SIGINT')
    .filter((listener) => !listenersBefore.includes(listener));
  assert.equal(installedListeners.length, 1);
  assert.equal(requestSignal.aborted, false);

  installedListeners[0]();

  await assert.rejects(pendingRequest, (error) => {
    assert.ok(error instanceof FriendlyError);
    assert.equal(error.message, 'Synthetic offline cancellation.');
    assert.equal(error.exitCode, 130);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(process.rawListeners('SIGINT'), listenersBefore);
});

test('an output collision stops before input loading, credentials, or a request', async () => {
  let loadedInputs = false;
  let loadedCredentials = false;
  let requested = false;
  const stderr = captureOutput();

  await assert.rejects(
    runDiffReview(
      [
        '--spec',
        'issue.md',
        '--diff',
        'change.diff',
        '--output',
        'issue.md'
      ],
      {
        stdout: captureOutput().stream,
        stderr: stderr.stream,
        outputPathDependencies: {
          cwd: 'C:\\workspace',
          pathImpl: path.win32,
          platform: 'win32',
          fsImpl: {
            async realpath() {
              const error = new Error('not found');
              error.code = 'ENOENT';
              throw error;
            }
          }
        },
        loadDiffReviewInputs: async () => {
          loadedInputs = true;
          return { specification: 'A requirement', diff: '+change' };
        },
        loadApiKey: () => {
          loadedCredentials = true;
          return 'synthetic-test-key';
        },
        requestChatCompletion: async () => {
          requested = true;
          return { text: 'Report', usage: null };
        }
      }
    ),
    /must not overwrite the specification or diff input/
  );

  assert.equal(loadedInputs, false);
  assert.equal(loadedCredentials, false);
  assert.equal(requested, false);
  assert.equal(stderr.read(), '');
});

test('runDiffReview streaming appends one terminal newline but saves exact report text', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  let saved;
  const report = '# Hy3 PR Readiness Report\n\nReady after fixes';

  const result = await runDiffReview(
    [
      '--spec',
      'issue.md',
      '--diff',
      'change.diff',
      '--output',
      'reports/review.md'
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async (options) => {
        assert.equal(options.stream, true);
        await options.onText('# Hy3 PR Readiness Report\n');
        await options.onText('\nReady after fixes');
        return {
          text: report,
          usage: { total_tokens: 9 },
          finishReason: 'stop'
        };
      },
      writeReportAtomic: async (outputPath, report) => {
        saved = { outputPath, report };
        return path.resolve(outputPath);
      }
    }
  );

  assert.equal(stdout.read(), `${report}\n`);
  assert.doesNotMatch(stdout.read(), /Reading|Sending|Saved/);
  assert.match(stderr.read(), /Reading specification/);
  assert.match(stderr.read(), /Sending review request/);
  assert.match(stderr.read(), /Saved report to/);
  assert.deepEqual(saved, {
    outputPath: 'reports/review.md',
    report
  });
  assert.deepEqual(result, {
    text: report,
    usage: { total_tokens: 9 },
    finishReason: 'stop'
  });
});

test('runDiffReview --no-stream appends one terminal newline when content lacks it', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  let requestOptions;

  await runDiffReview(
    ['--spec', 'issue.md', '--diff', 'change.diff', '--no-stream'],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async (options) => {
        requestOptions = options;
        return { text: '# Report', usage: null, finishReason: null };
      }
    }
  );

  assert.equal(requestOptions.stream, false);
  assert.equal(requestOptions.onText, undefined);
  assert.equal(stdout.read(), '# Report\n');
});

test('streaming truncation keeps partial stdout but does not publish an output file', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'reports', 'review.md');
  const stdout = captureOutput();
  const stderr = captureOutput();
  const partial = '# Partial review';

  const outcome = await runMainThroughTopLevelHandler(
    [
      'diff-review',
      '--spec',
      'issue.md',
      '--diff',
      'change.diff',
      '--output',
      outputPath
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async (options) => {
        await options.onText(partial);
        return { text: partial, usage: null, finishReason: 'length' };
      }
    }
  );

  assert.equal(outcome.exitCode, 1);
  assert.ok(outcome.error instanceof FriendlyError);
  assert.equal(stdout.read(), `${partial}\n`);
  assert.match(stderr.read(), /output token limit was reached/);
  assert.match(stderr.read(), /review is incomplete and was not saved/);
  assert.match(stderr.read(), /reduce the input scope and retry/);
  assert.doesNotMatch(stderr.read(), /Saved report to|Unexpected error|\n\s+at /);
  await assert.rejects(fs.access(outputPath), (error) => error.code === 'ENOENT');
});

test('streaming truncation preserves an existing terminal newline', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const partial = '# Partial review\n';

  const outcome = await runMainThroughTopLevelHandler(
    ['diff-review', '--spec', 'issue.md', '--diff', 'change.diff'],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async (options) => {
        await options.onText(partial);
        return { text: partial, usage: null, finishReason: 'length' };
      }
    }
  );

  assert.equal(outcome.exitCode, 1);
  assert.equal(stdout.read(), partial);
  assert.match(stderr.read(), /review is incomplete and was not saved/);
});

test('non-streaming truncation suppresses incomplete stdout and output publication', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'reports', 'review.md');
  const stdout = captureOutput();
  const stderr = captureOutput();

  const outcome = await runMainThroughTopLevelHandler(
    [
      'diff-review',
      '--spec',
      'issue.md',
      '--diff',
      'change.diff',
      '--no-stream',
      '--output',
      outputPath
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async () => ({
        text: '# Incomplete report',
        usage: null,
        finishReason: 'length'
      })
    }
  );

  assert.equal(outcome.exitCode, 1);
  assert.ok(outcome.error instanceof FriendlyError);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /output token limit was reached/);
  assert.doesNotMatch(stderr.read(), /Saved report to|Unexpected error|\n\s+at /);
  await assert.rejects(fs.access(outputPath), (error) => error.code === 'ENOENT');
});

test('truncation leaves an existing output report byte-for-byte unchanged', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'review.md');
  const originalReport = Buffer.from('# Existing report\r\n\0preserve me', 'utf8');
  await fs.writeFile(outputPath, originalReport);

  const outcome = await runMainThroughTopLevelHandler(
    [
      'diff-review',
      '--spec',
      'issue.md',
      '--diff',
      'change.diff',
      '--no-stream',
      '--output',
      outputPath
    ],
    {
      stdout: captureOutput().stream,
      stderr: captureOutput().stream,
      loadDiffReviewInputs: async () => ({
        specification: 'Return stable JSON.',
        diff: '+return {};'
      }),
      loadApiKey: () => 'synthetic-test-key',
      requestChatCompletion: async () => ({
        text: '# Replacement that must not be published',
        usage: null,
        finishReason: 'length'
      })
    }
  );

  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(await fs.readFile(outputPath), originalReport);
});

test('runDiffReview does not add an extra newline when content already ends with one', async (t) => {
  for (const stream of [true, false]) {
    await t.test(stream ? 'streaming' : 'non-streaming', async () => {
      const stdout = captureOutput();
      const report = '# Report\n';
      const args = ['--spec', 'issue.md', '--diff', 'change.diff'];
      if (!stream) {
        args.push('--no-stream');
      }

      await runDiffReview(args, {
        stdout: stdout.stream,
        stderr: captureOutput().stream,
        loadDiffReviewInputs: async () => ({
          specification: 'Return stable JSON.',
          diff: '+return {};'
        }),
        loadApiKey: () => 'synthetic-test-key',
        requestChatCompletion: async (options) => {
          if (stream) {
            await options.onText(report);
          }
          return { text: report, usage: null };
        }
      });

      assert.equal(stdout.read(), report);
    });
  }
});

test('runDiffReview does not create or publish an output file after request failure', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'reports', 'review.md');
  let writerCalled = false;

  await assert.rejects(
    runDiffReview(
      [
        '--spec',
        'issue.md',
        '--diff',
        'change.diff',
        '--output',
        outputPath
      ],
      {
        stdout: captureOutput().stream,
        stderr: captureOutput().stream,
        loadDiffReviewInputs: async () => ({
          specification: 'Return stable JSON.',
          diff: '+return {};'
        }),
        loadApiKey: () => 'synthetic-test-key',
        requestChatCompletion: async () => {
          throw new FriendlyError('Synthetic offline request failure.');
        },
        writeReportAtomic: async () => {
          writerCalled = true;
        }
      }
    ),
    /Synthetic offline request failure/
  );

  assert.equal(writerCalled, false);
  await assert.rejects(fs.access(outputPath), (error) => error.code === 'ENOENT');
});
