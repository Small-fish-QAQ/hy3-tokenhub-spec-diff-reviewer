'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createOfflineProvider } = require('../lib/offline_provider');
const { FriendlyError } = require('../lib/tokenhub');
const { startServer } = require('../lib/server');

const VIEWPORTS = Object.freeze([
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 }
]);
const OUTPUT_DIRECTORY = path.resolve(__dirname, '..', 'docs', 'assets', 'browser');

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

    const state = await evaluate(client, `(() => ({
      verdict: document.getElementById('verdict-heading').textContent,
      coverageRows: document.querySelectorAll('#coverage-body tr').length,
      findings: document.querySelectorAll('.finding-card').length,
      evidenceGroups: document.querySelectorAll('details.evidence').length,
      progress: [...document.querySelectorAll('#progress-list li')].map((item) => item.textContent),
      downloadsVisible: !document.getElementById('download-actions').hidden,
      validation: document.getElementById('validation-badge').textContent,
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
    const downloadedJson = JSON.parse(
      await fs.readFile(path.join(downloadPath, 'codex-hy3-review.json'), 'utf8')
    );
    if (downloadedJson.result?.verdict !== 'not_ready') {
      throw new Error('Downloaded JSON did not contain the visible offline verdict.');
    }

    await evaluate(client, "document.getElementById('start-review').click()", true);
    await waitForExpression(client, "!document.getElementById('cancel-review').disabled", 2_000);
    await evaluate(client, "document.getElementById('cancel-review').click()", true);
    await waitForExpression(
      client,
      "document.getElementById('run-status').textContent.includes('cancelled')",
      2_000
    );
    await waitUntil(() => cancellationObserved, 2_000, 'Server did not observe browser cancellation.');

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
      consoleErrors: 0
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
  if (state.coverageRows < 1) throw new Error('Coverage matrix did not render.');
  if (state.findings < 1) throw new Error('Findings did not render.');
  if (state.evidenceGroups < 1) throw new Error('Expandable evidence did not render.');
  if (!state.downloadsVisible) throw new Error('Download actions were not visible.');
  if (state.errorVisible) throw new Error('The successful review left an error visible.');
  if (!/schema passed.*evidence passed/.test(state.validation)) {
    throw new Error(`Validation state was not visible: ${state.validation}`);
  }
  if (state.offlineLabel !== 'OFFLINE / FAKE') throw new Error('Offline result was not visibly labelled.');
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
