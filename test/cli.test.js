'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FriendlyError } = require('../lib/tokenhub');
const {
  callModel,
  formatTopLevelError,
  handleTopLevelError,
  loadApiKey,
  main,
  runDiffReview
} = require('../hy3_showcase');
const { run: runStagedWrapper } = require('../scripts/review_staged');

const SPECIFICATION = 'R1: Return stable JSON.';
const DIFF = [
  'diff --git a/src/value.js b/src/value.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/value.js',
  '@@ -0,0 +1 @@',
  '+return {};',
  ''
].join('\n');

function validResult(overrides = {}) {
  return {
    verdict: 'ready',
    summary: 'The supplied change meets the normalized requirement.',
    coverage: [
      {
        requirementId: 'R1',
        status: 'met',
        explanation: 'The added line supplies the requested stable object.',
        evidence: [
          { source: 'spec', requirementId: 'R1', startLine: 1, endLine: 1, quote: SPECIFICATION },
          { source: 'diff', path: 'src/value.js', side: 'added', startLine: 1, endLine: 1, quote: 'return {};' }
        ]
      }
    ],
    findings: [],
    missingTests: [],
    uncertainties: [],
    ...overrides
  };
}

function captureOutput() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); return true; } },
    read() { return value; }
  };
}

function liveDependencies(overrides = {}) {
  return {
    stdout: captureOutput().stream,
    stderr: captureOutput().stream,
    environment: {},
    loadApiKey: () => 'synthetic-test-key',
    loadDiffReviewInputs: async () => ({ specification: SPECIFICATION, diff: DIFF }),
    requestChatCompletion: async () => ({
      text: JSON.stringify(validResult()),
      usage: { total_tokens: 9 },
      finishReason: 'stop'
    }),
    ...overrides
  };
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hy3-cli-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('general help advertises the focused reviewer, preflight, browser, and Codex command', async () => {
  const stdout = captureOutput();
  const exitCode = await main(['--help'], { stdout: stdout.stream });
  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Codex \+ Hy3 Evidence-Grounded Spec Diff Reviewer/);
  assert.match(stdout.read(), /^  diff-review\b/m);
  assert.match(stdout.read(), /^  check\b/m);
  assert.match(stdout.read(), /^  serve\b/m);
  assert.match(stdout.read(), /npm run review:staged/);
});

test('removed legacy commands are rejected before credentials or provider access', async (t) => {
  for (const command of ['chat', 'summarize', 'code-review', 'brief', 'all']) {
    await t.test(command, async () => {
      let touched = false;
      await assert.rejects(main([command], {
        loadApiKey() { touched = true; },
        requestChatCompletion() { touched = true; }
      }), new RegExp(`Invalid command: ${command}`));
      assert.equal(touched, false);
    });
  }
});

test('diff-review help does not load credentials or call TokenHub', async () => {
  const stdout = captureOutput();
  let touched = false;
  assert.equal(await main(['diff-review', '--help'], {
    stdout: stdout.stream,
    loadApiKey() { touched = true; },
    requestChatCompletion() { touched = true; }
  }), 0);
  assert.equal(touched, false);
  assert.match(stdout.read(), /--offline/);
  assert.match(stdout.read(), /default: 180/);
});

test('loadApiKey rejects whitespace and the placeholder, then trims a usable key', () => {
  assert.throws(() => loadApiKey({ TOKENHUB_API_KEY: ' \r\n ' }), /Missing TOKENHUB_API_KEY/);
  assert.throws(
    () => loadApiKey({ TOKENHUB_API_KEY: ' your_tokenhub_api_key_here ' }),
    /Missing TOKENHUB_API_KEY/
  );
  assert.equal(loadApiKey({ TOKENHUB_API_KEY: ' usable-key \r\n' }), 'usable-key');
});

test('callModel propagates Ctrl+C through AbortSignal and returns exit code 130', async () => {
  const before = process.rawListeners('SIGINT');
  let signal;
  const pending = callModel({}, {
    requestChatCompletion(options) {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new FriendlyError('cancelled')), { once: true });
      });
    }
  });
  const installed = process.rawListeners('SIGINT').filter((listener) => !before.includes(listener));
  assert.equal(installed.length, 1);
  installed[0]();
  await assert.rejects(pending, (error) => error.exitCode === 130 && error.message === 'cancelled');
  assert.equal(signal.aborted, true);
  assert.deepEqual(process.rawListeners('SIGINT'), before);
});

test('output collision stops before input, credential, or provider loading', async () => {
  let touched = false;
  await assert.rejects(runDiffReview(
    ['--spec', 'issue.md', '--diff', 'change.diff', '--output', 'issue.md'],
    {
      stdout: captureOutput().stream,
      stderr: captureOutput().stream,
      outputPathDependencies: {
        cwd: 'C:\\workspace',
        pathImpl: path.win32,
        platform: 'win32',
        fsImpl: { async realpath() { const error = new Error(); error.code = 'ENOENT'; throw error; } }
      },
      loadDiffReviewInputs() { touched = true; },
      loadApiKey() { touched = true; }
    }
  ), /must not overwrite/);
  assert.equal(touched, false);
});

test('live streaming waits for validation, renders Markdown, and publishes matching JSON', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  let requestOptions;
  let published;
  const result = await runDiffReview(
    ['--spec', 'issue.md', '--diff', 'change.diff', '--output', 'reports/review.md'],
    liveDependencies({
      stdout: stdout.stream,
      stderr: stderr.stream,
      onProviderChunk() {},
      requestChatCompletion: async (options) => {
        requestOptions = options;
        await options.onText('{');
        return { text: JSON.stringify(validResult()), usage: null, finishReason: 'stop' };
      },
      publishReviewOutputs: async (outputPath, markdown, json) => {
        published = { outputPath, markdown, json };
        return { markdownPath: path.resolve(outputPath), jsonPath: path.resolve('reports/review.json') };
      }
    })
  );
  assert.equal(requestOptions.stream, true);
  assert.doesNotMatch(stdout.read(), /^\{/);
  assert.match(stdout.read(), /^# Codex \+ Hy3 Spec Diff Review/m);
  assert.match(stdout.read(), /## READY/);
  assert.match(stderr.read(), /validating_schema/);
  assert.equal(published.outputPath, 'reports/review.md');
  assert.equal(published.markdown, result.markdown);
  assert.deepEqual(JSON.parse(published.json).result, result.result);
});

test('non-streaming direct CLI uses the same structured renderer', async () => {
  let requestOptions;
  const stdout = captureOutput();
  await runDiffReview(['--spec', 'issue.md', '--diff', 'change.diff', '--no-stream'], liveDependencies({
    stdout: stdout.stream,
    requestChatCompletion: async (options) => {
      requestOptions = options;
      return { text: JSON.stringify(validResult()), usage: null, finishReason: 'stop' };
    }
  }));
  assert.equal(requestOptions.stream, false);
  assert.match(stdout.read(), /Local evidence validation \| passed/);
});

test('truncated streaming and non-streaming output never reaches stdout or publication', async (t) => {
  for (const stream of [true, false]) {
    await t.test(stream ? 'streaming' : 'non-streaming', async () => {
      const stdout = captureOutput();
      let published = false;
      const args = ['--spec', 'issue.md', '--diff', 'change.diff'];
      if (!stream) args.push('--no-stream');
      await assert.rejects(runDiffReview(args, liveDependencies({
        stdout: stdout.stream,
        requestChatCompletion: async (options) => {
          if (options.onText) await options.onText('{"verdict"');
          return { text: '{"verdict"', finishReason: 'length' };
        },
        publishReviewOutputs() { published = true; }
      })), /truncated/);
      assert.equal(stdout.read(), '');
      assert.equal(published, false);
    });
  }
});

test('content filtering and unknown finish reasons are never completed reviews', async (t) => {
  for (const finishReason of ['content_filter', null, 'tool_calls']) {
    await t.test(String(finishReason), async () => {
      await assert.rejects(runDiffReview(
        ['--spec', 'issue.md', '--diff', 'change.diff'],
        liveDependencies({
          requestChatCompletion: async () => ({
            text: JSON.stringify(validResult()),
            finishReason
          })
        })
      ), /finish reason|content-filtered/);
    });
  }
});

test('malformed JSON gets exactly one repair attempt and no publication when repair fails', async () => {
  let calls = 0;
  let published = false;
  await assert.rejects(runDiffReview(
    ['--spec', 'issue.md', '--diff', 'change.diff'],
    liveDependencies({
      requestChatCompletion: async () => {
        calls += 1;
        return { text: '{bad', finishReason: 'stop' };
      },
      publishReviewOutputs() { published = true; }
    })
  ), /single bounded repair attempt/);
  assert.equal(calls, 2);
  assert.equal(published, false);
});

test('provider failure leaves an existing output bundle unchanged', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const outputPath = path.join(directory, 'review.md');
  await fs.writeFile(outputPath, 'existing', 'utf8');
  await assert.rejects(runDiffReview(
    ['--spec', 'issue.md', '--diff', 'change.diff', '--output', outputPath],
    liveDependencies({
      requestChatCompletion: async () => { throw new FriendlyError('Synthetic provider failure.'); }
    })
  ), /Synthetic provider failure/);
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'existing');
});

test('staged Codex wrapper invokes the same exported CLI entrypoint', async () => {
  let received;
  const exitCode = await runStagedWrapper(['--spec', 'examples/spec.md'], {
    main(args) { received = args; return 0; }
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(received, [
    'diff-review',
    '--git',
    '--spec',
    'examples/spec.md'
  ]);
});

test('top-level errors redact known credential shapes without a stack trace', () => {
  const error = new FriendlyError('Bearer top-secret api_key=also-secret');
  assert.equal(formatTopLevelError(error), 'Bearer [redacted] api_key=[redacted]');
  const output = captureOutput();
  assert.equal(handleTopLevelError(error, output.stream), 1);
  assert.doesNotMatch(output.read(), /top-secret|also-secret|\s+at /);
});
