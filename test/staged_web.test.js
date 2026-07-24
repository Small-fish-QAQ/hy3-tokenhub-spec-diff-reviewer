'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');

const {
  STAGED_DIFF_COMMAND,
  collectStagedBootstrap,
  openBrowserWindow,
  parseStagedWebArgs,
  resolveRepository,
  runStagedReviewConsole,
  safeLauncherMessage
} = require('../lib/staged_web');
const { createReviewServer, publicBootstrap, startReviewServer } = require('../lib/server');
const { run: runStagedWebWrapper } = require('../scripts/review_staged_web');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const LAUNCHER_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'review_staged_web.js');
const FIXTURE_SPEC_PATH = path.resolve(__dirname, '..', 'samples', 'offline', 'missing-behavior', 'spec.md');
const SESSION_SOURCE = [
  'export function sessionStatus(lastSeen, now) {',
  '  const elapsed = now - lastSeen;',
  "  return elapsed > 30 * 60 * 1000 ? 'expired' : 'active';",
  '}',
  ''
].join('\n');

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function makeTemporaryDirectory(t, prefix = 'hy3-staged-web-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return fs.realpath(directory);
}

async function initStagedRepository(t, { stage = true, writeSpec = true, root } = {}) {
  const repositoryRoot = root || await makeTemporaryDirectory(t);
  await git(['init'], repositoryRoot);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/staged-demo'], repositoryRoot);
  if (writeSpec) {
    await fs.mkdir(path.join(repositoryRoot, 'examples'), { recursive: true });
    await fs.copyFile(FIXTURE_SPEC_PATH, path.join(repositoryRoot, 'examples', 'spec.md'));
  }
  await fs.mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repositoryRoot, 'src', 'session.js'), SESSION_SOURCE, 'utf8');
  if (stage) await git(['add', 'src/session.js'], repositoryRoot);
  return repositoryRoot;
}

async function startTestServer(t, options = {}) {
  const server = createReviewServer({ env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  return `http://127.0.0.1:${server.address().port}`;
}

function captureOutput() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); return true; } },
    read() { return value; }
  };
}

function fakeExecFile(handler) {
  return (command, args, options, callback) => {
    Promise.resolve().then(() => {
      const outcome = handler(args, options, command) || {};
      callback(outcome.error || null, outcome.stdout || '', outcome.stderr || '');
    });
  };
}

function pathVariants(directory) {
  return [directory, directory.split(path.sep).join('/'), JSON.stringify(directory).slice(1, -1)];
}

function assertSanitizedText(serialized, repositoryRoot, secrets = []) {
  for (const variant of pathVariants(repositoryRoot)) {
    assert.equal(serialized.includes(variant), false, `leaked repository path variant: ${variant}`);
  }
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, 'leaked a server-side secret');
  }
}

test('a staged temporary repository produces a sanitized bootstrap payload', async (t) => {
  const root = await initStagedRepository(t);
  const bootstrap = await collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root });

  assert.equal(bootstrap.source, 'staged');
  assert.equal(bootstrap.label, 'Staged Git change');
  assert.equal(bootstrap.repository, path.basename(root));
  assert.equal(bootstrap.branch, 'staged-demo');
  assert.equal(bootstrap.specPath, 'examples/spec.md');
  assert.equal(bootstrap.diffCommand, STAGED_DIFF_COMMAND);
  assert.equal(bootstrap.preferredMode, 'live');
  assert.equal(
    bootstrap.specification,
    await fs.readFile(path.join(root, 'examples', 'spec.md'), 'utf8')
  );
  assert.match(bootstrap.diff, /^diff --git a\/src\/session\.js b\/src\/session\.js$/m);
  assert.match(bootstrap.diff, /^\+export function sessionStatus\(lastSeen, now\) \{$/m);

  assert.equal(bootstrap.specPath.includes('\\'), false);
  assert.doesNotMatch(bootstrap.specPath, /^[A-Za-z]:|^[\\/]/);
  assertSanitizedText(JSON.stringify(bootstrap), root);
});

test('missing --spec and malformed launcher options fail before any activity', () => {
  assert.throws(() => parseStagedWebArgs([]), /Missing required option: --spec/);
  assert.throws(() => parseStagedWebArgs(['--no-open']), /Missing required option: --spec/);
  assert.throws(() => parseStagedWebArgs(['--spec']), /requires a value/);
  assert.throws(() => parseStagedWebArgs(['--spec', 'a.md', '--spec', 'b.md']), /only be provided once/);
  assert.throws(() => parseStagedWebArgs(['--unknown']), /Unknown staged review console option/);
  assert.throws(() => parseStagedWebArgs(['--spec', 'a.md', '--host', '0.0.0.0']), /loopback/);
  assert.deepEqual(
    parseStagedWebArgs(['--spec', 'examples/spec.md', '--port', '0', '--no-open']),
    { open: false, help: false, spec: 'examples/spec.md', port: 0 }
  );
});

test('missing, non-regular, and outside-repository spec paths fail with actionable errors', async (t) => {
  const parent = await makeTemporaryDirectory(t);
  const root = path.join(parent, 'repo');
  await fs.mkdir(root, { recursive: true });
  await initStagedRepository(t, { root, writeSpec: false });
  await fs.mkdir(path.join(parent, 'outside'), { recursive: true });
  await fs.writeFile(path.join(parent, 'outside', 'spec.md'), '1. Outside requirement.\n', 'utf8');

  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root }),
    /Specification file not found: examples\/spec\.md/
  );
  await assert.rejects(
    collectStagedBootstrap({ spec: 'src', cwd: root }),
    /not a regular readable file/
  );
  await assert.rejects(
    collectStagedBootstrap({ spec: '../outside/spec.md', cwd: root }),
    /outside the reviewed repository/
  );
  await assert.rejects(
    collectStagedBootstrap({ spec: path.join(parent, 'outside', 'spec.md'), cwd: root }),
    /outside the reviewed repository/
  );
});

test('a non-Git working directory and a missing Git executable are rejected clearly', async () => {
  const notARepository = fakeExecFile((args) => {
    if (args.includes('--show-toplevel')) {
      return {
        error: Object.assign(new Error('git exited 128'), { code: 128 }),
        stderr: 'fatal: not a git repository (or any of the parent directories): .git'
      };
    }
    return { stdout: '' };
  });
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: os.tmpdir(), execFileImpl: notARepository }),
    /not inside a Git repository/
  );

  const gitUnavailable = fakeExecFile(() => ({
    error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  }));
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: os.tmpdir(), execFileImpl: gitUnavailable }),
    /Git is not available on PATH/
  );
});

test('a repository without staged changes explains how to stage the intended diff', async (t) => {
  const root = await initStagedRepository(t, { stage: false });
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root }),
    (error) => {
      assert.match(error.message, /No staged changes were found in repository/);
      assert.match(error.message, /git add/);
      return true;
    }
  );
});

test('staged diff retrieval failures stay actionable and redact credential shapes', async (t) => {
  const root = await initStagedRepository(t);
  const failDiffOnly = (command, args, options, callback) => {
    if (args.includes('diff')) {
      Promise.resolve().then(() => callback(
        Object.assign(new Error('git exited 128'), { code: 128 }),
        '',
        'fatal: bad object api_key=super-secret-value'
      ));
      return;
    }
    execFile(command, args, options, callback);
  };
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root, execFileImpl: failDiffOnly }),
    (error) => {
      assert.match(error.message, /Unable to read the staged Git diff/);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, /super-secret-value/);
      return true;
    }
  );
});

test('the staged console serves the sanitized bootstrap and completes the canonical review', async (t) => {
  const secret = 'staged-web-server-secret';
  const root = await initStagedRepository(t);
  const bootstrap = await collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root });
  const baseUrl = await startTestServer(t, { env: { TOKENHUB_API_KEY: secret }, bootstrap });

  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.stagedBootstrap, true);
  assert.equal(config.liveAvailable, true);

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrapText = await bootstrapResponse.text();
  assertSanitizedText(bootstrapText, root, [secret]);
  const payload = JSON.parse(bootstrapText);
  assert.equal(payload.staged.specification, bootstrap.specification);
  assert.equal(payload.staged.diff, bootstrap.diff);
  assert.equal(payload.staged.specPath, 'examples/spec.md');
  assert.equal(payload.staged.preferredMode, 'live');
  assert.equal((await fetch(`${baseUrl}/api/bootstrap`, { method: 'POST' })).status, 404);

  const review = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({
      specification: payload.staged.specification,
      diff: payload.staged.diff,
      mode: 'offline',
      stream: true
    })
  });
  assert.equal(review.status, 200);
  const events = (await review.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const completed = events.find((event) => event.type === 'result');
  assert.ok(completed, 'expected a completed offline review of the real staged content');
  assert.equal(completed.review.result.verdict, 'not_ready');
  assert.deepEqual(
    Object.fromEntries(completed.review.result.coverage.map((item) => [item.requirementId, item.status])),
    { R1: 'met', R2: 'met', R3: 'missing', R4: 'missing', R5: 'missing' }
  );
  assert.equal(completed.review.result.coverage.filter((item) => item.status === 'met').length, 2);
  assert.equal(completed.review.result.findings.length, 2);
  assert.ok(completed.review.result.findings.every((finding) => finding.severity === 'P1'));
  assert.equal(completed.review.result.missingTests.length, 3);
  assert.deepEqual(completed.review.provenance.validation, { schema: 'passed', evidence: 'passed' });
});

test('the launcher starts a sanitized loopback console and honors --no-open', async (t) => {
  const root = await initStagedRepository(t);
  const stdout = captureOutput();
  const stderr = captureOutput();
  let spawnCalls = 0;
  const launched = await runStagedReviewConsole(
    ['--spec', 'examples/spec.md', '--port', '0', '--no-open'],
    {
      cwd: root,
      environment: { TOKENHUB_API_KEY: 'launcher-e2e-secret' },
      stdout: stdout.stream,
      stderr: stderr.stream,
      spawnImpl: () => { spawnCalls += 1; return { once() {}, unref() {} }; }
    }
  );
  t.after(async () => {
    launched.server.closeAllConnections?.();
    await new Promise((resolve) => launched.server.close(resolve));
  });

  assert.match(launched.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(spawnCalls, 0);
  const printed = stdout.read();
  assert.match(printed, /staged Git change — repository /);
  assert.match(printed, /Specification: examples\/spec\.md/);
  assert.match(printed, new RegExp(`Staged diff: \\d+ lines from \`${STAGED_DIFF_COMMAND}\``));
  assert.match(printed, /Review mode: Live \/ Hy3 preselected\n/);
  assert.match(printed, /Bound to loopback only/);
  assertSanitizedText(printed, root, ['launcher-e2e-secret']);
  assert.equal(stderr.read(), '');

  const config = await (await fetch(`${launched.url}/api/config`)).json();
  assert.equal(config.stagedBootstrap, true);
});

test('the launcher warns clearly when no usable live credential is configured', async (t) => {
  const root = await initStagedRepository(t);
  const stdout = captureOutput();
  const stderr = captureOutput();
  const launched = await runStagedReviewConsole(
    ['--spec', 'examples/spec.md', '--port', '0', '--no-open'],
    { cwd: root, environment: {}, stdout: stdout.stream, stderr: stderr.stream }
  );
  t.after(async () => {
    launched.server.closeAllConnections?.();
    await new Promise((resolve) => launched.server.close(resolve));
  });

  assert.match(stdout.read(), /Live \/ Hy3 preselected \(no usable TokenHub credential detected\)/);
  assert.match(stderr.read(), /set TOKENHUB_API_KEY in \.env/);
  assert.match(stderr.read(), /Offline \/ Fake/);
});

test('the launcher help path performs no Git or server activity', async () => {
  const stdout = captureOutput();
  let touched = false;
  const result = await runStagedReviewConsole(['--help'], {
    stdout: stdout.stream,
    execFileImpl: () => { touched = true; },
    startServer: () => { touched = true; }
  });
  assert.equal(result, null);
  assert.equal(touched, false);
  assert.match(stdout.read(), /--spec <path>/);
  assert.match(stdout.read(), /never modified/);
});

test('openBrowserWindow launches only the fixed loopback URL for each platform', () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push([command, ...args]);
    return { once() {}, unref() {} };
  };
  const url = 'http://127.0.0.1:4173';
  assert.equal(openBrowserWindow(url, { platform: 'win32', spawnImpl }), true);
  assert.equal(openBrowserWindow(url, { platform: 'darwin', spawnImpl }), true);
  assert.equal(openBrowserWindow(url, { platform: 'linux', spawnImpl }), true);
  assert.deepEqual(calls, [
    ['cmd.exe', '/c', 'start', '', url],
    ['open', url],
    ['xdg-open', url]
  ]);

  let reported = false;
  const failed = openBrowserWindow(url, {
    platform: 'linux',
    spawnImpl: () => { throw new Error('no browser available'); },
    onOpenError: () => { reported = true; }
  });
  assert.equal(failed, false);
  assert.equal(reported, true);
});

test('the plain serve console keeps manual workflows with no staged bootstrap', async (t) => {
  const baseUrl = await startTestServer(t);
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.stagedBootstrap, false);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/bootstrap`)).json(), { staged: null });
  const sample = await (await fetch(`${baseUrl}/api/sample`)).json();
  assert.match(sample.specification, /Session timeout/);
  assert.match(sample.diff, /^diff --git/m);
});

test('an occupied port produces an actionable startup error', async (t) => {
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(
    startReviewServer({ port: blocker.address().port, host: '127.0.0.1', env: {} }),
    /already in use/
  );
});

test('the npm wrapper delegates arguments to the staged console launcher', async () => {
  let received;
  const outcome = await runStagedWebWrapper(['--spec', 'examples/spec.md'], {
    runStagedReviewConsole(args) { received = args; return 'launched'; }
  });
  assert.equal(outcome, 'launched');
  assert.deepEqual(received, ['--spec', 'examples/spec.md']);
});

test('browser assets expose the staged state and the bootstrap projection stays whitelisted', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile(path.join(WEB_ROOT, 'index.html'), 'utf8'),
    fs.readFile(path.join(WEB_ROOT, 'app.js'), 'utf8'),
    fs.readFile(path.join(WEB_ROOT, 'styles.css'), 'utf8')
  ]);
  assert.match(html, /id="staged-banner"[^>]*hidden/);
  assert.match(html, /id="staged-summary"/);
  assert.match(html, /id="staged-edited"/);
  assert.match(script, /\/api\/bootstrap/);
  assert.match(script, /Review with Hy3/);
  assert.match(script, /stagedBootstrap/);
  assert.equal(/apiKey|authorization|tokenhub_api_key/i.test(script), false);
  assert.match(styles, /\.staged-banner/);

  const projected = publicBootstrap({
    repository: 'demo',
    branch: 'main',
    specPath: 'examples/spec.md',
    diffCommand: STAGED_DIFF_COMMAND,
    specification: 'spec text',
    diff: 'diff text',
    preferredMode: 'live',
    absolutePath: 'C:/leaky/path/spec.md',
    apiKey: 'leaky-secret',
    extra: { nested: true }
  });
  assert.deepEqual(
    Object.keys(projected).sort(),
    ['branch', 'diff', 'diffCommand', 'label', 'preferredMode', 'repository', 'source', 'specPath', 'specification']
  );
  assert.equal(JSON.stringify(projected).includes('leaky'), false);
  assert.equal(publicBootstrap(null), null);
  assert.equal(publicBootstrap(undefined), null);
});

test('the package exposes the staged launcher as the hy3-review-staged executable', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.resolve(__dirname, '..', 'package.json'), 'utf8')
  );
  assert.equal(packageJson.bin['hy3-review-staged'], 'scripts/review_staged_web.js');
  const script = await fs.readFile(LAUNCHER_SCRIPT, 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /runStagedReviewConsole/);
});

test('a spawned launcher process reviews the Git repository it is started in', async (t) => {
  const root = await initStagedRepository(t);
  const environment = { ...process.env, TOKENHUB_API_KEY: 'spawn-test-secret' };
  delete environment.INIT_CWD;
  const child = spawn(
    process.execPath,
    [LAUNCHER_SCRIPT, '--spec', 'examples/spec.md', '--port', '0', '--no-open'],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  // The child's working directory is inside the temporary repository, so it
  // must be gone before the directory-removal after-hook runs. Ending it in
  // a finally block (not a second after-hook) guarantees that ordering.
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`launcher never printed its loopback URL. stderr: ${stderr}`)),
        15_000
      );
      const check = () => {
        const match = stdout.match(/staged review console: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on('data', check);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`launcher exited early with code ${code}. stderr: ${stderr}`));
      });
      check();
    });

    const payload = (await (await fetch(`${url}/api/bootstrap`)).json()).staged;
    assert.equal(payload.repository, path.basename(root));
    assert.notEqual(payload.repository, 'hy3-tokenhub-mini-showcase');
    assert.equal(payload.specPath, 'examples/spec.md');
    assert.match(payload.diff, /^\+export function sessionStatus/m);
    assertSanitizedText(stdout + stderr, root, ['spawn-test-secret']);
  } finally {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    if (child.exitCode === null) child.kill();
    await exited;
  }
});

test('an in-repository file whose name begins with two dots is accepted', async (t) => {
  const root = await initStagedRepository(t, { writeSpec: false });
  await fs.copyFile(FIXTURE_SPEC_PATH, path.join(root, '..spec.md'));
  const bootstrap = await collectStagedBootstrap({ spec: '..spec.md', cwd: root });
  assert.equal(bootstrap.specPath, '..spec.md');
  assert.match(bootstrap.specification, /Session timeout/);
});

test('error messages never echo absolute specification paths', async (t) => {
  const parent = await makeTemporaryDirectory(t);
  const root = path.join(parent, 'repo');
  await fs.mkdir(root, { recursive: true });
  await initStagedRepository(t, { root, writeSpec: false });
  await fs.mkdir(path.join(parent, 'outside'), { recursive: true });
  const outsideExisting = path.join(parent, 'outside', 'leaky-spec.md');
  await fs.writeFile(outsideExisting, '1. Outside requirement.\n', 'utf8');
  const absoluteMissing = path.join(parent, 'outside', 'missing-spec.md');

  await assert.rejects(
    collectStagedBootstrap({ spec: absoluteMissing, cwd: root }),
    (error) => {
      assert.match(error.message, /Specification file not found: missing-spec\.md/);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      assertSanitizedText(error.message, parent);
      return true;
    }
  );
  await assert.rejects(
    collectStagedBootstrap({ spec: outsideExisting, cwd: root }),
    (error) => {
      assert.match(error.message, /outside the reviewed repository: leaky-spec\.md/);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      assertSanitizedText(error.message, parent);
      return true;
    }
  );
});

test('git failures with path-bearing stderr are scrubbed before display', async (t) => {
  const root = await initStagedRepository(t);
  const leakyPath = 'C:\\Users\\leaky-user\\secret-repo\\object';
  const failDiff = (command, args, options, callback) => {
    if (args.includes('diff')) {
      Promise.resolve().then(() => callback(
        Object.assign(new Error('git exited 128'), { code: 128 }),
        '',
        `fatal: unable to read ${leakyPath} api_key=super-secret`
      ));
      return;
    }
    execFile(command, args, options, callback);
  };
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root, execFileImpl: failDiff }),
    (error) => {
      assert.match(error.message, /Unable to read the staged Git diff/);
      assert.equal(error.message.includes('leaky-user'), false);
      assert.equal(error.message.includes('super-secret'), false);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      assert.match(error.message, /\[local path\]/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    }
  );
});

test('dubious-ownership Git failures give actionable guidance without echoing paths', async () => {
  const execFileImpl = fakeExecFile((args) => {
    if (args.includes('--show-toplevel')) {
      return {
        error: Object.assign(new Error('git exited 128'), { code: 128 }),
        stderr: "fatal: detected dubious ownership in repository at 'C:/Users/leaky-user/repo'"
      };
    }
    return { stdout: '' };
  });
  await assert.rejects(
    resolveRepository({ cwd: os.tmpdir(), execFileImpl }),
    (error) => {
      assert.match(error.message, /dubious ownership/i);
      assert.match(error.message, /safe\.directory/);
      assert.equal(error.message.includes('leaky-user'), false);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      return true;
    }
  );
});

test('other repository-resolution failures stay generic without raw Git stderr', async () => {
  const execFileImpl = fakeExecFile((args) => {
    if (args.includes('--show-toplevel')) {
      return {
        error: Object.assign(new Error('git exited 1'), { code: 1 }),
        stderr: 'error: cannot access C:\\Users\\leaky-user\\broken'
      };
    }
    return { stdout: '' };
  });
  await assert.rejects(
    resolveRepository({ cwd: os.tmpdir(), execFileImpl }),
    (error) => {
      assert.match(error.message, /Unable to locate the Git repository root/);
      assert.equal(error.message.includes('leaky-user'), false);
      return true;
    }
  );
});

test('repository and branch display fields strip control characters', async () => {
  const execFileImpl = fakeExecFile((args) => {
    if (args.includes('--show-toplevel')) return { stdout: '/tmp/repo\u0007na\u001bme\n' };
    if (args.includes('--show-current')) return { stdout: 'demo\u001b]0;evil\u0007\n' };
    return { stdout: '' };
  });
  const repository = await resolveRepository({
    cwd: '/anywhere',
    execFileImpl,
    fsImpl: { realpath: async (value) => value }
  });
  assert.equal(repository.name, 'reponame');
  assert.equal(repository.branch, 'demo]0;evil');
  const displayed = JSON.stringify({ name: repository.name, branch: repository.branch });
  assert.equal(displayed.includes('\\u001b'), false);
  assert.equal(displayed.includes('\\u0007'), false);
});

test('safeLauncherMessage scrubs known paths, generic paths, secrets, and control characters', () => {
  const message = 'fail at C:\\Users\\leaky\\repo with Bearer abc123 then \u001b[31mred\u001b[0m and /home/leaky/self';
  const safe = safeLauncherMessage(message, ['C:\\Users\\leaky\\repo']);
  assert.equal(safe.includes('leaky'), false);
  assert.equal(safe.includes('abc123'), false);
  assert.equal(safe.includes('\u001b'), false);
  assert.match(safe, /\[repository path\]/);
  assert.match(safe, /\[local path\]/);
  assert.match(safe, /Bearer \[redacted\]/);
});

test('unknown launcher options are rejected without echoing the raw argument', () => {
  const hostileArguments = [
    '--C:\\Users\\leaky-user\\payload',
    '--api_key=super-secret-value',
    '--bad\u001b]0;spoofed-title\u0007'
  ];
  for (const argument of hostileArguments) {
    try {
      parseStagedWebArgs([argument]);
      assert.fail(`expected rejection for ${JSON.stringify(argument)}`);
    } catch (error) {
      assert.match(error.message, /Unknown staged review console option/);
      assert.match(error.message, /--spec <path>/);
      assert.equal(error.message.includes('leaky-user'), false);
      assert.equal(error.message.includes('super-secret-value'), false);
      assert.equal(error.message.includes('\u001b'), false);
      assert.equal(error.message.includes('\u0007'), false);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
    }
  }
});

test('an in-repository symlink resolving outside the repository is rejected without path disclosure', async (t) => {
  const parent = await makeTemporaryDirectory(t);
  const root = path.join(parent, 'repo');
  await fs.mkdir(root, { recursive: true });
  await initStagedRepository(t, { root, writeSpec: false });
  await fs.mkdir(path.join(parent, 'outside'), { recursive: true });
  await fs.writeFile(path.join(parent, 'outside', 'secret-spec.md'), '1. Outside requirement.\n', 'utf8');

  try {
    await fs.symlink(path.join(parent, 'outside'), path.join(root, 'linked-docs'), 'junction');
  } catch (error) {
    t.skip(`symlink/junction creation is unavailable here (${error.code}).`);
    return;
  }

  await assert.rejects(
    collectStagedBootstrap({ spec: 'linked-docs/secret-spec.md', cwd: root }),
    (error) => {
      assert.match(error.message, /outside the reviewed repository: secret-spec\.md/);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      assertSanitizedText(error.message, parent);
      return true;
    }
  );
});

test('specification realpath failures fail closed with a sanitized error', async (t) => {
  const root = await initStagedRepository(t);
  const failingRealpath = {
    stat: (...statArgs) => fs.stat(...statArgs),
    realpath: async () => {
      throw Object.assign(
        new Error("EPERM: operation not permitted, realpath 'C:\\Users\\leaky-user\\spec.md'"),
        { code: 'EPERM' }
      );
    }
  };
  await assert.rejects(
    collectStagedBootstrap({ spec: 'examples/spec.md', cwd: root, fsImpl: failingRealpath }),
    (error) => {
      assert.match(error.message, /Unable to verify the real location of the specification file: examples\/spec\.md/);
      assert.equal(error.message.includes('leaky-user'), false);
      assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/);
      assertSanitizedText(error.message, root);
      return true;
    }
  );
});
