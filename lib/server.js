'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { createOfflineProvider, OFFLINE_FIXTURES } = require('./offline_provider');
const { reviewArtifacts, sanitizeProviderHost } = require('./review_engine');
const {
  DEFAULT_BASE_URL,
  MODEL,
  FriendlyError,
  createTokenHubProvider,
  redactSecrets
} = require('./tokenhub');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const SAMPLE_FILES = Object.freeze({
  specification: path.resolve(__dirname, '..', 'samples', 'offline', 'missing-behavior', 'spec.md'),
  diff: path.resolve(__dirname, '..', 'samples', 'offline', 'missing-behavior', 'change.diff')
});
const STATIC_FILES = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' }
});
const ALLOWED_REVIEW_FIELDS = new Set([
  'specification',
  'diff',
  'mode',
  'stream',
  'fixture'
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function createReviewServer(options = {}) {
  const environment = options.env || process.env;
  const review = options.reviewArtifacts || reviewArtifacts;
  const offlineProviderFactory = options.createOfflineProvider || createOfflineProvider;
  const liveProviderFactory = options.createLiveProvider || createTokenHubProvider;
  const webRoot = options.webRoot || WEB_ROOT;
  const maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  const sampleLoader = options.loadSample || loadBundledSample;
  const bootstrap = publicBootstrap(options.bootstrap);

  return http.createServer(async (request, response) => {
    applySecurityHeaders(response);

    try {
      if (!isLoopbackHostHeader(request.headers.host)) {
        throw new HttpError(400, 'The local review server accepts only loopback Host headers.');
      }

      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.search || requestUrl.hash) {
        throw new HttpError(404, 'Not found.');
      }

      if (requestUrl.pathname.startsWith('/api/') && !isSameOriginRequest(request)) {
        throw new HttpError(403, 'Cross-origin API requests are not allowed.');
      }

      if (request.method === 'GET' && STATIC_FILES[requestUrl.pathname]) {
        await serveStatic(response, STATIC_FILES[requestUrl.pathname], webRoot);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
        sendJson(response, 200, publicConfiguration(environment, maxBodyBytes, bootstrap));
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/bootstrap') {
        sendJson(response, 200, { staged: bootstrap });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/sample') {
        const sample = await sampleLoader();
        sendJson(response, 200, sample);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/review') {
        requireJsonContentType(request);
        const body = validateReviewBody(await readJsonBody(request, maxBodyBytes));
        await streamReview({
          request,
          response,
          body,
          environment,
          review,
          offlineProviderFactory,
          liveProviderFactory
        });
        return;
      }

      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed && !response.writableEnded) {
          endNdjsonError(response, error);
        }
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'The local review server failed safely.';
      sendJson(response, status, { error: message });
    }
  });
}

async function streamReview({
  request,
  response,
  body,
  environment,
  review,
  offlineProviderFactory,
  liveProviderFactory
}) {
  const controller = new AbortController();
  const requestId = randomUUID();
  let clientClosed = false;
  let receivedCharacters = 0;
  const model = body.mode === 'offline' ? 'hy3-offline-fake' : serverModel(environment);
  const baseUrl = serverBaseUrl(environment);
  const apiKey = serverApiKey(environment);

  const abortForDisconnect = () => {
    if (!response.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  };
  request.once('aborted', abortForDisconnect);
  response.once('close', abortForDisconnect);

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });

  const writeEvent = (event) => {
    if (clientClosed || response.destroyed || response.writableEnded) return false;
    return response.write(`${JSON.stringify(event)}\n`);
  };

  writeEvent({
    type: 'accepted',
    requestId,
    mode: body.mode,
    model,
    offline: body.mode === 'offline'
  });

  try {
    let provider;
    if (body.mode === 'offline') {
      provider = offlineProviderFactory({ fixture: body.fixture });
    } else {
      if (!isUsableApiKey(apiKey)) {
        throw new FriendlyError(
          'Live mode is unavailable because TOKENHUB_API_KEY is not configured on the local server. Use Offline / Fake mode or configure the server environment.'
        );
      }
      provider = liveProviderFactory({
        apiKey,
        baseUrl,
        model,
        temperature: 0.1,
        maxTokens: 4_000,
        responseFormat: { type: 'json_object' },
        onRetry(event) {
          writeEvent({
            type: 'progress',
            stage: 'retrying_provider',
            label: `Retrying provider (${event.attempt}/${event.maxRetries})`,
            detail: { delayMs: event.delayMs, code: event.code }
          });
        }
      });
    }

    const completed = await review({
      specification: body.specification,
      diff: body.diff,
      provider,
      mode: body.mode,
      model,
      baseUrl,
      stream: body.stream,
      signal: controller.signal,
      onProgress(event) {
        writeEvent({ type: 'progress', ...event });
      },
      async onProviderChunk(chunk) {
        receivedCharacters += typeof chunk === 'string' ? chunk.length : 0;
        writeEvent({ type: 'provider_activity', receivedCharacters });
      }
    });

    if (!clientClosed) {
      response.end(`${JSON.stringify({
        type: 'result',
        review: {
          result: completed.result,
          provenance: completed.provenance,
          markdown: completed.markdown,
          json: completed.json
        }
      })}\n`);
    }
  } catch (error) {
    if (!clientClosed && !response.destroyed) {
      endNdjsonError(response, error, apiKey);
    }
  } finally {
    request.removeListener('aborted', abortForDisconnect);
    response.removeListener('close', abortForDisconnect);
  }
}

function endNdjsonError(response, error, apiKey) {
  const message = safeBrowserError(error, apiKey);
  if (!response.writableEnded) {
    response.end(`${JSON.stringify({
      type: 'error',
      code: safeErrorCode(error),
      message
    })}\n`);
  }
}

function safeBrowserError(error, apiKey) {
  if (error instanceof FriendlyError || error instanceof HttpError) {
    return redactSecrets(error.message, apiKey ? [apiKey] : []);
  }
  return 'Review failed safely. Inspect the local server terminal for operational diagnostics.';
}

function safeErrorCode(error) {
  const value = error && typeof error.code === 'string' ? error.code : 'REVIEW_FAILED';
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'REVIEW_FAILED';
}

function validateReviewBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'The review request must be a JSON object.');
  }

  const unknownFields = Object.keys(value).filter((key) => !ALLOWED_REVIEW_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new HttpError(400, `Unsupported review request field: ${unknownFields[0]}.`);
  }
  if (typeof value.specification !== 'string') {
    throw new HttpError(400, 'specification must be a string.');
  }
  if (typeof value.diff !== 'string') {
    throw new HttpError(400, 'diff must be a string.');
  }
  if (value.mode !== 'offline' && value.mode !== 'live') {
    throw new HttpError(400, 'mode must be either offline or live.');
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') {
    throw new HttpError(400, 'stream must be a boolean when provided.');
  }

  const fixture = value.fixture === undefined ? 'auto' : value.fixture;
  if (typeof fixture !== 'string' || (fixture !== 'auto' && !OFFLINE_FIXTURES.includes(fixture))) {
    throw new HttpError(400, 'fixture must identify a supported deterministic offline fixture.');
  }
  if (value.mode === 'live' && value.fixture !== undefined && value.fixture !== 'auto') {
    throw new HttpError(400, 'fixture selection is available only in offline mode.');
  }

  return {
    specification: value.specification,
    diff: value.diff,
    mode: value.mode,
    stream: value.stream !== false,
    fixture
  };
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;

  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > limit) {
        throw new HttpError(413, `Request body exceeds the local ${limit}-byte limit.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Unable to read the JSON request body.');
  }

  if (bytes === 0) throw new HttpError(400, 'The JSON request body is empty.');
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (_error) {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

function requireJsonContentType(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
}

async function serveStatic(response, entry, webRoot = WEB_ROOT) {
  const content = await fs.readFile(path.resolve(webRoot, entry.file));
  response.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache'
  });
  response.end(content);
}

async function loadBundledSample() {
  const [specification, diff] = await Promise.all([
    fs.readFile(SAMPLE_FILES.specification, 'utf8'),
    fs.readFile(SAMPLE_FILES.diff, 'utf8')
  ]);
  return {
    name: 'Session timeout boundary gap',
    description: 'A self-authored staged-diff example with exact-threshold and future timestamp defects plus missing regression tests.',
    fixture: 'missing-behavior',
    specification,
    diff
  };
}

function publicConfiguration(environment, maxBodyBytes, bootstrap = null) {
  const apiKey = serverApiKey(environment);
  return {
    defaultMode: 'offline',
    liveAvailable: isUsableApiKey(apiKey),
    model: serverModel(environment),
    providerHost: sanitizeProviderHost(serverBaseUrl(environment)),
    maxBodyBytes,
    stagedBootstrap: Boolean(bootstrap)
  };
}

/**
 * Project a CLI-collected staged payload onto a fixed field whitelist so the
 * browser receives only known fields: sanitized display metadata plus the two
 * review artifacts. The projection adds no server credential, environment
 * value, absolute-path metadata, or unknown fields. The specification and
 * diff pass through verbatim by design — they are user-authored review input
 * and may contain whatever the user wrote or staged.
 */
function publicBootstrap(bootstrap) {
  if (!bootstrap || typeof bootstrap !== 'object') return null;
  return {
    source: 'staged',
    label: 'Staged Git change',
    repository: safeBootstrapText(bootstrap.repository),
    branch: bootstrap.branch === null || bootstrap.branch === undefined
      ? null
      : safeBootstrapText(bootstrap.branch),
    specPath: safeBootstrapText(bootstrap.specPath),
    diffCommand: safeBootstrapText(bootstrap.diffCommand),
    specification: typeof bootstrap.specification === 'string' ? bootstrap.specification : '',
    diff: typeof bootstrap.diff === 'string' ? bootstrap.diff : '',
    preferredMode: bootstrap.preferredMode === 'offline' ? 'offline' : 'live'
  };
}

function safeBootstrapText(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    : '';
}

function serverApiKey(environment) {
  return typeof environment.TOKENHUB_API_KEY === 'string'
    ? environment.TOKENHUB_API_KEY.trim()
    : '';
}

function serverBaseUrl(environment) {
  return typeof environment.HY3_BASE_URL === 'string' && environment.HY3_BASE_URL.trim()
    ? environment.HY3_BASE_URL.trim()
    : DEFAULT_BASE_URL;
}

function serverModel(environment) {
  return typeof environment.HY3_MODEL === 'string' && environment.HY3_MODEL.trim()
    ? environment.HY3_MODEL.trim()
    : MODEL;
}

function isUsableApiKey(value) {
  return Boolean(value && value !== 'your_tokenhub_api_key_here');
}

function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  } catch (_error) {
    return false;
  }
}

function isSameOriginRequest(request) {
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === 'http:' &&
      originUrl.host.toLowerCase() === String(request.headers.host).toLowerCase() &&
      ['127.0.0.1', 'localhost', '::1'].includes(originUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch (_error) {
    return false;
  }
}

function applySecurityHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function parsePort(value) {
  const port = Number(value === undefined || value === '' ? DEFAULT_PORT : value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new FriendlyError('HY3_WEB_PORT must be a whole number from 0 to 65535.');
  }
  return port;
}

function parseHost(value) {
  const host = value || DEFAULT_HOST;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new FriendlyError('HY3_WEB_HOST must be a loopback address: 127.0.0.1, localhost, or ::1.');
  }
  return host;
}

function parseServerArgs(args) {
  const options = { help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new FriendlyError(`Option ${argument} may only be provided once.`);
    seen.add(argument);
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument !== '--port' && argument !== '--host') {
      throw new FriendlyError(`Unknown serve option: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new FriendlyError(`Option ${argument} requires a value.`);
    }
    if (argument === '--port') options.port = parsePort(value);
    else options.host = parseHost(value);
    index += 1;
  }
  return options;
}

function loadServerEnvironment(environment) {
  if (environment) return environment;
  require('dotenv').config({ quiet: true });
  return process.env;
}

async function startReviewServer(options = {}) {
  const environment = loadServerEnvironment(options.env);
  const host = parseHost(options.host || environment.HY3_WEB_HOST);
  const port = parsePort(options.port ?? environment.HY3_WEB_PORT);
  const server = createReviewServer({ ...options, env: environment });

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(translateListenError(error, host, port));
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.removeListener('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  const displayHost = host === '::1' ? '[::1]' : host;
  const url = `http://${displayHost}:${address.port}`;
  return { server, url };
}

function translateListenError(error, host, port) {
  if (error?.code === 'EADDRINUSE') {
    return new FriendlyError(
      `Port ${port} on ${host} is already in use. Stop the other local process or choose a different port with --port or HY3_WEB_PORT.`
    );
  }
  if (error?.code === 'EACCES') {
    return new FriendlyError(
      `Port ${port} on ${host} is not permitted for this user. Choose a different port with --port or HY3_WEB_PORT.`
    );
  }
  return error;
}

if (require.main === module) {
  startReviewServer()
    .then(({ url }) => {
      process.stdout.write(`Codex + Hy3 review console: ${url}\n`);
      process.stdout.write('Bound to loopback only. Press Ctrl+C to stop.\n');
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error?.message || String(error))}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  STATIC_FILES,
  HttpError,
  createReviewServer,
  isLoopbackHostHeader,
  isSameOriginRequest,
  isUsableApiKey,
  loadBundledSample,
  parseHost,
  parsePort,
  parseServerArgs,
  publicBootstrap,
  publicConfiguration,
  readJsonBody,
  startReviewServer,
  startServer: startReviewServer,
  translateListenError,
  validateReviewBody
};
