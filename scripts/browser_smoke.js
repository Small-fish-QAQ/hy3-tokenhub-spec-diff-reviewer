'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const { createOfflineProvider } = require('../lib/offline_provider');
const { collectStagedBootstrap } = require('../lib/staged_web');
const { FriendlyError } = require('../lib/tokenhub');
const { startServer } = require('../lib/server');

const VIEWPORTS = Object.freeze([
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 }
]);
const OUTPUT_DIRECTORY = path.resolve(__dirname, '..', 'docs', 'assets', 'browser');
const STAGED_SESSION_SOURCE = [
  'export function sessionStatus(lastSeen, now) {',
  '  const elapsed = now - lastSeen;',
  "  return elapsed > 30 * 60 * 1000 ? 'expired' : 'active';",
  '}',
  ''
].join('\n');

async function main() {
  const chromePath = await findChrome();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hy3-browser-smoke-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  const downloadPath = path.join(temporaryRoot, 'downloads');
  const debugPort = await reservePort();
  let providerCount = 0;
  let cancellationObserved = false;

  const { server, url } = await startServer({
    port: 0,
    host: '127.0.0.1',
    env: {},
    createOfflineProvider(options) {
      providerCount += 1;
      const provider = createOfflineProvider(options);
      if (providerCount === 1) return provider;
      return {
        generate(request) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              provider.generate(request).then(resolve, reject);
            }, 5_000);
            const onAbort = () => {
              cancellationObserved = true;
              clearTimeout(timer);
              reject(new FriendlyError('Synthetic delayed offline browser smoke cancelled.'));
            };
            if (request.signal?.aborted) onAbort();
            else request.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      };
    }
  });

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    'about:blank'
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });

  let browserStderr = '';
  chrome.stderr.on('data', (chunk) => {
    browserStderr += chunk.toString('utf8');
    if (browserStderr.length > 8_000) browserStderr = browserStderr.slice(-8_000);
  });

  let client;
  let summary;
  try {
    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 8_000);
    const page = await fetchJson(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }
    );
    client = await CdpClient.connect(page.webSocketDebuggerUrl || version.webSocketDebuggerUrl);
    const consoleProblems = [];
    client.on('Runtime.exceptionThrown', (event) => {
      consoleProblems.push(event.exceptionDetails?.text || 'Uncaught browser exception');
    });
    client.on('Log.entryAdded', (event) => {
      if (event.entry?.level === 'error') consoleProblems.push(event.entry.text);
    });

    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Log.enable')
    ]);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__browserSmokeUnhandledRejections = [];
        window.addEventListener('unhandledrejection', (event) => {
          window.__browserSmokeUnhandledRejections.push(String(event.reason?.message || event.reason));
        });`
    });
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath,
      eventsEnabled: true
    });
    await fs.mkdir(downloadPath, { recursive: true });

    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url });
    await loaded;
    await waitForExpression(client, "document.getElementById('model-badge').textContent.includes('hy3')", 5_000);

    await evaluate(client, "document.getElementById('load-sample').click()", true);
    await waitForExpression(client, "document.getElementById('specification').value.length > 100", 5_000);
    await evaluate(client, "document.getElementById('start-review').click()", true);
    await waitForExpression(
      client,
      "!document.getElementById('review-output').hidden && document.getElementById('run-status').textContent.includes('Review complete')",
      10_000
    );

    await evaluate(client, `(() => {
      for (const details of document.querySelectorAll('#findings-list details.evidence')) {
        details.open = true;
      }
    })()`);

    const state = await evaluate(client, `(() => ({
      verdict: document.getElementById('verdict-heading').textContent,
      coverageSummary: document.getElementById('coverage-summary').textContent,
      coverage: [...document.querySelectorAll('#coverage-body tr')].map((row) => {
        const cells = row.querySelectorAll('td');
        return {
          requirementId: cells[0]?.textContent.trim(),
          status: cells[1]?.textContent.trim().toLowerCase(),
          evidenceLocations: [...row.querySelectorAll('.evidence-location')]
            .map((item) => item.textContent.trim())
        };
      }),
      findings: [...document.querySelectorAll('.finding-card')].map((card) => ({
        severity: card.querySelector('.severity')?.textContent.trim(),
        title: card.querySelector('h4')?.textContent.trim(),
        evidenceOpen: card.querySelector('details.evidence')?.open === true,
        evidenceText: card.querySelector('details.evidence')?.textContent || ''
      })),
      missingTests: [...document.querySelectorAll('#missing-tests .result-list > li')].map((item) => ({
        title: item.querySelector('strong')?.textContent.replace(/:\\s*$/, '').trim(),
        text: item.textContent
      })),
      missingTestsText: document.getElementById('missing-tests').textContent,
      evidenceGroups: document.querySelectorAll('details.evidence').length,
      progress: [...document.querySelectorAll('#progress-list li')].map((item) => item.textContent),
      downloadsVisible: !document.getElementById('download-actions').hidden,
      validation: document.getElementById('validation-badge').textContent,
      localValidation: document.getElementById('local-validation').textContent,
      provenanceText: document.getElementById('provenance-grid').textContent,
      errorVisible: !document.getElementById('error-box').hidden,
      offlineLabel: document.getElementById('mode-badge').textContent
    }))()`);

    assertSmokeState(state);
    await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
    const viewportResults = [];
    for (const viewport of VIEWPORTS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false
      });
      await evaluate(client, 'window.scrollTo(0, 0)');
      const layout = await evaluate(client, `(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        gridColumns: getComputedStyle(document.querySelector('.review-grid')).gridTemplateColumns
      }))()`);
      if (layout.documentWidth > viewport.width) {
        throw new Error(`Horizontal page overflow at ${viewport.width}x${viewport.height}: ${layout.documentWidth}px.`);
      }
      const screenshot = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      });
      const filename = `review-console-${viewport.width}x${viewport.height}.png`;
      await fs.writeFile(path.join(OUTPUT_DIRECTORY, filename), Buffer.from(screenshot.data, 'base64'));
      viewportResults.push({ ...viewport, gridColumns: layout.gridColumns, screenshot: filename });
    }

    await evaluate(client, "document.getElementById('download-markdown').click()", true);
    await evaluate(client, "document.getElementById('download-json').click()", true);
    await waitForFiles(downloadPath, ['codex-hy3-review.md', 'codex-hy3-review.json'], 5_000);
    const downloadedMarkdown = await fs.readFile(
      path.join(downloadPath, 'codex-hy3-review.md'),
      'utf8'
    );
    const downloadedJson = JSON.parse(
      await fs.readFile(path.join(downloadPath, 'codex-hy3-review.json'), 'utf8')
    );
    assertDownloadedArtifacts(downloadedJson, downloadedMarkdown, state);

    await evaluate(client, "document.getElementById('start-review').click()", true);
    await waitForExpression(client, "!document.getElementById('cancel-review').disabled", 2_000);
    await evaluate(client, "document.getElementById('cancel-review').click()", true);
    await waitForExpression(
      client,
      "document.getElementById('run-status').textContent.includes('cancelled')",
      2_000
    );
    await waitUntil(() => cancellationObserved, 2_000, 'Server did not observe browser cancellation.');

    const stagedConsole = await runStagedConsolePhase({ debugPort, temporaryRoot });

    const unhandledRejections = await evaluate(
      client,
      'window.__browserSmokeUnhandledRejections || []'
    );
    if (unhandledRejections.length > 0) {
      throw new Error(`Browser reported unhandled rejections: ${unhandledRejections.join(' | ')}`);
    }

    if (consoleProblems.length > 0) {
      throw new Error(`Browser console reported errors: ${consoleProblems.join(' | ')}`);
    }

    summary = {
      browser: chromePath,
      mode: 'OFFLINE / FAKE',
      state,
      viewportResults,
      downloads: ['codex-hy3-review.md', 'codex-hy3-review.json'],
      cancellationObserved,
      stagedConsole,
      consoleErrors: 0,
      unhandledRejections: 0
    };
  } catch (error) {
    if (browserStderr) error.message += `\nChrome diagnostics:\n${browserStderr}`;
    throw error;
  } finally {
    client?.close();
    chrome.kill();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await onceExit(chrome, 2_000);
    await removeOwnedTemporaryDirectory(temporaryRoot);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function assertSmokeState(state) {
  if (state.verdict !== 'NOT READY') throw new Error(`Unexpected visible verdict: ${state.verdict}`);
  if (state.coverageSummary !== '2/5 met') {
    throw new Error(`Unexpected visible coverage summary: ${state.coverageSummary}`);
  }
  assertExactCoverage(state.coverage, 'visible coverage matrix');
  const r4 = state.coverage.find((item) => item.requirementId === 'R4');
  if (r4.evidenceLocations.some((location) => location.startsWith('diff '))) {
    throw new Error('Visible R4 coverage falsely cited implementation evidence.');
  }
  if (state.findings.length !== 2 || state.findings.some((finding) => finding.severity !== 'P1')) {
    throw new Error('The browser must show exactly two P1 findings.');
  }
  const thresholdFinding = state.findings.find((finding) =>
    /strict greater-than|30[- ]minute.*boundary|threshold/i.test(finding.title)
  );
  const futureFinding = state.findings.find((finding) => /future.*lastSeen/i.test(finding.title));
  if (!thresholdFinding) throw new Error('The exact 30-minute threshold finding was not visible.');
  if (!futureFinding) throw new Error('The future-lastSeen finding was not visible.');
  if (state.findings.some((finding) => !finding.evidenceOpen)) {
    throw new Error('Finding evidence was not expanded for browser inspection.');
  }
  if (!/Return `expired` at or after exactly 30 minutes/.test(thresholdFinding.evidenceText)
      || !/elapsed\s*>\s*30\s*\*\s*60\s*\*\s*1000/.test(thresholdFinding.evidenceText)) {
    throw new Error('The threshold finding did not show its R3 specification and strict > evidence.');
  }
  if (!/Reject a `lastSeen` value that is later than `now`/.test(futureFinding.evidenceText)
      || !/const\s+elapsed\s*=\s*now\s*-\s*lastSeen/.test(futureFinding.evidenceText)
      || !/return\s+elapsed\s*>\s*30\s*\*\s*60\s*\*\s*1000/.test(futureFinding.evidenceText)) {
    throw new Error('The future-lastSeen finding did not show its R4 specification and implementation path.');
  }
  if (state.missingTests.length !== 3) {
    throw new Error(`Expected three visible missing tests, found ${state.missingTests.length}.`);
  }
  for (const pattern of [/29:59/, /30:00/, /future\s+lastSeen/i, /lastSeen\s*>\s*now/]) {
    if (!pattern.test(state.missingTestsText)) {
      throw new Error(`Missing-test text did not match ${pattern}.`);
    }
  }
  if (state.evidenceGroups < 1) throw new Error('Expandable evidence did not render.');
  if (!state.downloadsVisible) throw new Error('Download actions were not visible.');
  if (state.errorVisible) throw new Error('The successful review left an error visible.');
  if (!/schema passed.*evidence passed/.test(state.validation)) {
    throw new Error(`Validation state was not visible: ${state.validation}`);
  }
  if (!/passed schema.*passed evidence/.test(state.localValidation)) {
    throw new Error(`Local validation state was not visible: ${state.localValidation}`);
  }
  if (state.offlineLabel !== 'OFFLINE / FAKE') throw new Error('Offline result was not visibly labelled.');
}

function assertDownloadedArtifacts(downloadedJson, downloadedMarkdown, state) {
  if (downloadedJson.result?.verdict !== 'not_ready' || !/^## NOT READY$/m.test(downloadedMarkdown)) {
    throw new Error('Downloaded Markdown and JSON did not contain the visible offline verdict.');
  }
  assertExactCoverage(downloadedJson.result.coverage, 'downloaded JSON coverage');

  for (const item of downloadedJson.result.coverage) {
    const row = new RegExp(`^\\| ${item.requirementId} \\| ${item.status.toUpperCase()} \\|`, 'm');
    if (!row.test(downloadedMarkdown)) {
      throw new Error(`Downloaded Markdown did not agree with JSON status for ${item.requirementId}.`);
    }
  }

  const downloadedFindings = downloadedJson.result.findings || [];
  if (downloadedFindings.length !== 2 || downloadedFindings.some((finding) => finding.severity !== 'P1')) {
    throw new Error('Downloaded JSON did not contain exactly two P1 findings.');
  }
  if (JSON.stringify(downloadedFindings.map((finding) => finding.title))
      !== JSON.stringify(state.findings.map((finding) => finding.title))) {
    throw new Error('Downloaded JSON finding titles did not agree with the browser result.');
  }
  for (const finding of downloadedFindings) {
    if (!downloadedMarkdown.includes(`#### ${finding.title}`)) {
      throw new Error(`Downloaded Markdown omitted finding: ${finding.title}.`);
    }
  }

  const downloadedMissingTests = downloadedJson.result.missingTests || [];
  if (downloadedMissingTests.length !== 3) {
    throw new Error(`Downloaded JSON contained ${downloadedMissingTests.length} missing tests instead of three.`);
  }
  if (JSON.stringify(downloadedMissingTests.map((item) => item.title))
      !== JSON.stringify(state.missingTests.map((item) => item.title))) {
    throw new Error('Downloaded JSON missing-test titles did not agree with the browser result.');
  }
  for (const item of downloadedMissingTests) {
    if (!downloadedMarkdown.includes(`**${item.title}:**`)) {
      throw new Error(`Downloaded Markdown omitted missing test: ${item.title}.`);
    }
  }

  const hashes = [
    downloadedJson.provenance?.inputs?.specification?.sha256,
    downloadedJson.provenance?.inputs?.diff?.sha256
  ];
  for (const hash of hashes) {
    if (!hash || !state.provenanceText.includes(hash) || !downloadedMarkdown.includes(hash)) {
      throw new Error('Downloaded Markdown, JSON, and visible provenance hashes did not agree.');
    }
  }
}

function assertExactCoverage(coverage, label) {
  const expected = [
    ['R1', 'met'],
    ['R2', 'met'],
    ['R3', 'missing'],
    ['R4', 'missing'],
    ['R5', 'missing']
  ];
  const actual = (coverage || []).map((item) => [item.requirementId, item.status]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected ${label}: ${JSON.stringify(actual)}.`);
  }
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * Staged-console DOM phase: build a real temporary staged repository, serve
 * its sanitized bootstrap without a credential, and prove the browser-side
 * staged state end to end. Never performs a live provider request.
 */
async function runStagedConsolePhase({ debugPort, temporaryRoot }) {
  const repositoryRoot = path.join(temporaryRoot, 'staged-repo');
  await fs.mkdir(path.join(repositoryRoot, 'examples'), { recursive: true });
  await fs.mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await runGit(['init'], repositoryRoot);
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/staged-demo'], repositoryRoot);
  await fs.copyFile(
    path.resolve(__dirname, '..', 'samples', 'offline', 'missing-behavior', 'spec.md'),
    path.join(repositoryRoot, 'examples', 'spec.md')
  );
  await fs.writeFile(path.join(repositoryRoot, 'src', 'session.js'), STAGED_SESSION_SOURCE, 'utf8');
  await runGit(['add', 'src/session.js'], repositoryRoot);

  const bootstrap = await collectStagedBootstrap({ spec: 'examples/spec.md', cwd: repositoryRoot });
  const { server, url } = await startServer({ port: 0, host: '127.0.0.1', env: {}, bootstrap });
  let client;
  const consoleProblems = [];
  try {
    const page = await fetchJson(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }
    );
    client = await CdpClient.connect(page.webSocketDebuggerUrl);
    client.on('Runtime.exceptionThrown', (event) => {
      consoleProblems.push(event.exceptionDetails?.text || 'Uncaught browser exception');
    });
    client.on('Log.entryAdded', (event) => {
      if (event.entry?.level === 'error') consoleProblems.push(event.entry.text);
    });
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Log.enable')
    ]);
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url });
    await loaded;
    await waitForExpression(
      client,
      "document.getElementById('diff').value.startsWith('diff --git') && !document.getElementById('staged-banner').hidden",
      5_000
    );

    const state = await evaluate(client, `(() => ({
      specValue: document.getElementById('specification').value,
      diffValue: document.getElementById('diff').value,
      bannerHidden: document.getElementById('staged-banner').hidden,
      bannerText: document.getElementById('staged-summary').textContent,
      editedHidden: document.getElementById('staged-edited').hidden,
      mode: document.getElementById('mode').value,
      modeBadge: document.getElementById('mode-badge').textContent,
      offlineBannerHidden: document.getElementById('offline-banner').hidden,
      startLabel: document.getElementById('start-review').textContent,
      errorHidden: document.getElementById('error-box').hidden,
      errorText: document.getElementById('error-box').textContent,
      statusText: document.getElementById('run-status').textContent,
      bodyText: document.body.textContent
    }))()`);
    assertStagedConsoleState(state, bootstrap, repositoryRoot);

    await evaluate(client, `(() => {
      const diff = document.getElementById('diff');
      diff.value += 'x';
      diff.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    if (!(await evaluate(client, "!document.getElementById('staged-edited').hidden"))) {
      throw new Error('Editing the staged diff did not reveal the edited-after-load indicator.');
    }
    await evaluate(client, `(() => {
      const diff = document.getElementById('diff');
      diff.value = diff.value.slice(0, -1);
      diff.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    if (!(await evaluate(client, "document.getElementById('staged-edited').hidden"))) {
      throw new Error('Restoring the exact staged diff did not clear the edited indicator.');
    }

    await evaluate(client, "document.getElementById('load-sample').click()", true);
    await waitForExpression(
      client,
      "document.getElementById('run-status').textContent.includes('Loaded sample')",
      5_000
    );
    if (!(await evaluate(client, "!document.getElementById('staged-edited').hidden"))) {
      throw new Error('Loading the bundled sample did not mark the staged content as replaced.');
    }

    if (consoleProblems.length > 0) {
      throw new Error(`Staged console reported browser errors: ${consoleProblems.join(' | ')}`);
    }

    return {
      repository: bootstrap.repository,
      branch: bootstrap.branch,
      specPath: bootstrap.specPath,
      livePreselected: state.mode === 'live',
      startLabel: state.startLabel,
      credentialErrorShown: !state.errorHidden,
      editedIndicatorVerified: true,
      consoleErrors: 0
    };
  } finally {
    client?.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertStagedConsoleState(state, bootstrap, repositoryRoot) {
  if (state.specValue !== bootstrap.specification) {
    throw new Error('The specification textarea did not contain the exact staged spec.');
  }
  if (state.diffValue !== bootstrap.diff) {
    throw new Error('The diff textarea did not contain the exact staged diff.');
  }
  if (state.bannerHidden) throw new Error('The STAGED GIT CHANGE banner was not visible.');
  if (!state.bannerText.includes(bootstrap.repository) || !state.bannerText.includes(bootstrap.specPath)) {
    throw new Error(`The staged banner did not show the repository and spec path: ${state.bannerText}`);
  }
  if (!state.editedHidden) throw new Error('The edited indicator was visible before any edit.');
  if (state.mode !== 'live' || state.modeBadge !== 'LIVE') {
    throw new Error(`Live mode was not preselected: mode=${state.mode} badge=${state.modeBadge}`);
  }
  if (!state.offlineBannerHidden) {
    throw new Error('The offline banner was visible — the console silently switched to Offline.');
  }
  if (state.startLabel !== 'Review with Hy3') {
    throw new Error(`The primary action did not read Review with Hy3: ${state.startLabel}`);
  }
  if (state.errorHidden || !/TokenHub credential/.test(state.errorText) || !/Offline \/ Fake/.test(state.errorText)) {
    throw new Error('The no-credential state did not show the actionable Live error.');
  }
  if (!state.statusText.includes('Staged Git change loaded')) {
    throw new Error(`The staged status message was not visible: ${state.statusText}`);
  }
  for (const variant of [repositoryRoot, repositoryRoot.split(path.sep).join('/')]) {
    if (state.bodyText.includes(variant)) {
      throw new Error('An absolute repository path leaked into the visible DOM.');
    }
  }
  if (/[A-Za-z]:[\\/]/.test(state.bodyText)) {
    throw new Error('A drive-letter path leaked into the visible DOM.');
  }
  if (/TOKENHUB_API_KEY/.test(state.bodyText)) {
    throw new Error('A credential variable name leaked into the visible DOM.');
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Chrome DevTools connection closed.'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Unable to connect to Chrome DevTools.')), { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression, userGesture = false) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function waitForExpression(client, expression, timeoutMs) {
  await waitUntil(async () => Boolean(await evaluate(client, expression)), timeoutMs, `Timed out waiting for: ${expression}`);
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function waitForJson(url, timeoutMs) {
  let value;
  await waitUntil(async () => {
    try {
      value = await fetchJson(url);
      return true;
    } catch (_error) {
      return false;
    }
  }, timeoutMs, `Chrome DevTools did not become ready at ${url}.`);
  return value;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function waitForFiles(directory, names, timeoutMs) {
  await waitUntil(async () => {
    const files = await fs.readdir(directory).catch(() => []);
    return names.every((name) => files.includes(name));
  }, timeoutMs, `Browser downloads did not finish: ${names.join(', ')}`);
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await onceServer(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function onceServer(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.platform === 'win32' && path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform === 'linux' && '/usr/bin/google-chrome',
    process.platform === 'linux' && '/usr/bin/chromium'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch (_error) {
      // Try the next explicit browser location.
    }
  }
  throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run the browser smoke check.');
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs)
  ]);
}

async function removeOwnedTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith('hy3-browser-smoke-')) {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolved}`);
  }
  await fs.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
