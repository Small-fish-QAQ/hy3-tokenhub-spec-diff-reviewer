'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { once } = require('node:events');

const { createOfflineProvider } = require('../lib/offline_provider');
const { FriendlyError } = require('../lib/tokenhub');
const {
  createReviewServer,
  parseHost,
  parseServerArgs,
  validateReviewBody
} = require('../lib/server');

async function startTestServer(t, options = {}) {
  const server = createReviewServer({ env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  return `http://127.0.0.1:${address.port}`;
}

async function bundledSample(baseUrl) {
  const response = await fetch(`${baseUrl}/api/sample`);
  assert.equal(response.status, 200);
  return response.json();
}

async function reviewRequest(baseUrl, body, options = {}) {
  return fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      ...(options.headers || {})
    },
    body: JSON.stringify(body),
    signal: options.signal
  });
}

async function ndjsonEvents(response) {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('browser server exposes only the static whitelist with restrictive headers', async (t) => {
  const baseUrl = await startTestServer(t);
  const expected = [
    ['/', /text\/html/, /Codex \+ Hy3 Spec Diff Reviewer/],
    ['/app.js', /text\/javascript/, /startReview/],
    ['/styles.css', /text\/css/, /review-grid/]
  ];

  for (const [pathname, contentType, content] of expected) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), contentType);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(await response.text(), content);
  }

  const forbidden = await fetch(`${baseUrl}/package.json`);
  assert.equal(forbidden.status, 404);
  assert.deepEqual(await forbidden.json(), { error: 'Not found.' });
});

test('configuration and bundled sample never expose the server credential', async (t) => {
  const secret = 'server-only-browser-test-secret';
  const baseUrl = await startTestServer(t, {
    env: {
      TOKENHUB_API_KEY: secret,
      HY3_MODEL: 'hy3-browser-test',
      HY3_BASE_URL: 'https://tokenhub.tencentmaas.com/v1'
    }
  });

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal(configResponse.status, 200);
  const configText = await configResponse.text();
  assert.equal(configText.includes(secret), false);
  const config = JSON.parse(configText);
  assert.deepEqual(
    {
      defaultMode: config.defaultMode,
      liveAvailable: config.liveAvailable,
      model: config.model,
      providerHost: config.providerHost
    },
    {
      defaultMode: 'offline',
      liveAvailable: true,
      model: 'hy3-browser-test',
      providerHost: 'tokenhub.tencentmaas.com'
    }
  );

  const sample = await bundledSample(baseUrl);
  assert.equal(sample.fixture, 'missing-behavior');
  assert.match(sample.specification, /Session timeout/);
  assert.match(sample.diff, /^diff --git/m);
  assert.equal(JSON.stringify(sample).includes(secret), false);
});

test('offline browser review streams core-engine stages and a validated result', async (t) => {
  const baseUrl = await startTestServer(t);
  const sample = await bundledSample(baseUrl);
  const response = await reviewRequest(baseUrl, {
    specification: sample.specification,
    diff: sample.diff,
    mode: 'offline',
    fixture: sample.fixture,
    stream: true
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = await ndjsonEvents(response);
  assert.equal(events[0].type, 'accepted');
  assert.equal(events[0].offline, true);

  const stages = events.filter((event) => event.type === 'progress').map((event) => event.stage);
  for (const stage of [
    'validating_inputs',
    'preparing_specification',
    'reading_diff',
    'calling_provider',
    'validating_schema',
    'verifying_evidence',
    'rendering_report'
  ]) {
    assert.ok(stages.includes(stage), `missing streamed stage ${stage}`);
  }
  assert.ok(events.some((event) => event.type === 'provider_activity'));

  const completed = events.find((event) => event.type === 'result');
  assert.ok(completed);
  assert.equal(completed.review.result.verdict, 'not_ready');
  assert.equal(completed.review.provenance.mode, 'offline');
  assert.deepEqual(completed.review.provenance.validation, {
    schema: 'passed',
    evidence: 'passed'
  });
  assert.match(completed.review.markdown, /OFFLINE \/ FAKE/);
  const jsonArtifact = JSON.parse(completed.review.json);
  assert.deepEqual(jsonArtifact.result, completed.review.result);
  assert.deepEqual(jsonArtifact.provenance, completed.review.provenance);
});

test('live browser mode uses only the server-side credential with an injected provider', async (t) => {
  const secret = 'server-side-live-test-secret';
  let providerConfiguration;
  const baseUrl = await startTestServer(t, {
    env: {
      TOKENHUB_API_KEY: secret,
      HY3_MODEL: 'hy3',
      HY3_BASE_URL: 'https://tokenhub.tencentmaas.com/v1'
    },
    createLiveProvider(configuration) {
      providerConfiguration = configuration;
      return createOfflineProvider({ fixture: 'missing-behavior' });
    }
  });
  const sample = await bundledSample(baseUrl);
  const response = await reviewRequest(baseUrl, {
    specification: sample.specification,
    diff: sample.diff,
    mode: 'live',
    stream: true
  });
  const text = await response.text();
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.status, 200);
  assert.equal(providerConfiguration.apiKey, secret);
  assert.equal(text.includes(secret), false);
  const completed = events.find((event) => event.type === 'result');
  assert.ok(completed);
  assert.equal(completed.review.provenance.mode, 'live');
  assert.equal(completed.review.provenance.model, 'hy3');
});

test('review API rejects credential fields and malformed client payloads before provider creation', async (t) => {
  let providerCreated = false;
  const baseUrl = await startTestServer(t, {
    env: { TOKENHUB_API_KEY: 'server-side-secret' },
    createLiveProvider() {
      providerCreated = true;
      return createOfflineProvider({ fixture: 'compliant' });
    }
  });

  const response = await reviewRequest(baseUrl, {
    specification: '1. Return a value.',
    diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
    mode: 'live',
    stream: true,
    apiKey: 'client-supplied-secret'
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported review request field/);
  assert.equal(providerCreated, false);
  assert.throws(
    () => validateReviewBody({ specification: 'spec', diff: 'diff', mode: 'other' }),
    /mode must be either offline or live/
  );
});

test('live mode without a server credential returns a readable streamed failure', async (t) => {
  let providerCreated = false;
  const baseUrl = await startTestServer(t, {
    createLiveProvider() {
      providerCreated = true;
      return createOfflineProvider({ fixture: 'compliant' });
    }
  });
  const sample = await bundledSample(baseUrl);
  const response = await reviewRequest(baseUrl, {
    specification: sample.specification,
    diff: sample.diff,
    mode: 'live',
    stream: true
  });
  const events = await ndjsonEvents(response);

  assert.equal(response.status, 200);
  assert.equal(providerCreated, false);
  assert.equal(events[0].type, 'accepted');
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /TOKENHUB_API_KEY is not configured on the local server/);
});

test('browser failures redact server credentials and never expose provider stacks', async (t) => {
  const secret = 'browser-provider-stack-secret';
  const baseUrl = await startTestServer(t, {
    env: { TOKENHUB_API_KEY: secret },
    createLiveProvider() {
      return {
        async generate() {
          throw new Error(`internal provider detail containing ${secret}`);
        }
      };
    }
  });
  const sample = await bundledSample(baseUrl);
  const response = await reviewRequest(baseUrl, {
    specification: sample.specification,
    diff: sample.diff,
    mode: 'live',
    stream: true
  });
  const events = await ndjsonEvents(response);
  const failure = events.at(-1);

  assert.equal(failure.type, 'error');
  assert.match(failure.message, /Review failed safely/);
  assert.equal(failure.message.includes(secret), false);
  assert.doesNotMatch(failure.message, /internal provider detail|\n\s+at /);
});

test('review API enforces its body limit and same-origin boundary', async (t) => {
  const baseUrl = await startTestServer(t, { maxBodyBytes: 256 });
  const tooLarge = await reviewRequest(baseUrl, {
    specification: 'x'.repeat(400),
    diff: 'diff',
    mode: 'offline',
    stream: true
  });
  assert.equal(tooLarge.status, 413);
  assert.match((await tooLarge.json()).error, /exceeds the local 256-byte limit/);

  const crossOrigin = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: 'http://malicious.example' }
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: 'Cross-origin API requests are not allowed.' });
});

test('closing the streamed browser response aborts the shared review signal', async (t) => {
  let providerStarted;
  let providerAborted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const aborted = new Promise((resolve) => { providerAborted = resolve; });

  const baseUrl = await startTestServer(t, {
    env: { TOKENHUB_API_KEY: 'server-side-cancel-secret' },
    createLiveProvider() {
      return {
        generate({ signal }) {
          providerStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              providerAborted();
              reject(new FriendlyError('Synthetic browser cancellation.'));
            }, { once: true });
          });
        }
      };
    }
  });
  const sample = await bundledSample(baseUrl);
  const controller = new AbortController();
  const response = await reviewRequest(baseUrl, {
    specification: sample.specification,
    diff: sample.diff,
    mode: 'live',
    stream: true
  }, { signal: controller.signal });

  assert.equal(response.status, 200);
  await started;
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), (error) => error.name === 'AbortError');
  await Promise.race([
    aborted,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('server signal was not aborted')), 1_000))
  ]);
});

test('browser markup and client script expose accessible controls without credential payloads', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile(new URL('../web/index.html', `file://${__filename.replaceAll('\\', '/')}`), 'utf8'),
    fs.readFile(new URL('../web/app.js', `file://${__filename.replaceAll('\\', '/')}`), 'utf8'),
    fs.readFile(new URL('../web/styles.css', `file://${__filename.replaceAll('\\', '/')}`), 'utf8')
  ]);

  for (const id of ['mode', 'specification', 'diff']) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
  }
  assert.match(html, /id="run-status" role="status" aria-live="polite"/);
  assert.match(html, /id="error-box" role="alert"/);
  assert.match(html, /id="cancel-review"[^>]+disabled/);
  assert.match(html, /Download Markdown/);
  assert.match(html, /Download JSON/);
  assert.match(html, /tabindex="0" aria-label="Scrollable requirement coverage table"/);
  assert.match(script, /if \(activeController \|\| sampleLoading\) return/);
  assert.match(script, /runId !== runSequence/);
  assert.match(script, /controller\.abort\(\)/);
  assert.equal(/apiKey|authorization|tokenhub_api_key/i.test(script), false);
  assert.match(styles, /grid-template-columns: minmax\(250px/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
});

test('serve arguments accept only explicit loopback bindings', () => {
  assert.deepEqual(parseServerArgs([]), { help: false });
  assert.deepEqual(parseServerArgs(['--port', '4321', '--host', 'localhost']), {
    help: false,
    port: 4321,
    host: 'localhost'
  });
  assert.equal(parseHost(undefined), '127.0.0.1');
  assert.throws(() => parseHost('0.0.0.0'), /must be a loopback address/);
  assert.throws(() => parseServerArgs(['--host', '192.0.2.1']), /must be a loopback address/);
  assert.throws(() => parseServerArgs(['--unknown']), /Unknown serve option/);
});
