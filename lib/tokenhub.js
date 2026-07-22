'use strict';

const { TextDecoder } = require('node:util');

const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
const TOKENHUB_ENDPOINT = `${DEFAULT_BASE_URL}/chat/completions`;
const MODEL = 'hy3';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_ERROR_TEXT_LENGTH = 2_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

class FriendlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FriendlyError';
  }
}

class ProviderError extends FriendlyError {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Remove known secrets and common credential-shaped values from user-facing text.
 * Only strings derived from response bodies or Error.message should be passed on
 * to callers; response objects and headers must never be included in errors.
 */
function redactSecrets(value, secrets = []) {
  if (value === undefined || value === null) {
    return value;
  }

  let safe = String(value);
  const knownSecrets = Array.isArray(secrets) ? secrets : [secrets];

  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      safe = safe.split(secret).join('[redacted]');
    }
  }

  safe = safe.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]');
  safe = safe.replace(
    /(\b(?:tokenhub[ _-]?api[ _-]?key|x[ _-]?api[ _-]?key|api[ _-]?key|apikey)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
    '$1[redacted]'
  );

  return safe;
}

function apiErrorMessage(payload, apiKey) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  let error = payload.error;
  if (!error && payload.type === 'error') {
    error = payload.message || payload.detail || 'Unknown API error';
  }

  if (!error) {
    return null;
  }

  let message;
  if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object') {
    message = error.message || error.detail || error.code || 'Unknown API error';
  } else {
    message = 'Unknown API error';
  }

  return redactSecrets(message, apiKey);
}

function parseJson(text, contextMessage) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new FriendlyError(contextMessage);
  }
}

/**
 * Parse a successful, non-streaming Chat Completions response.
 * `body` may be the response text or an already parsed object.
 */
function parseNonStreamingResponse(body, apiKey) {
  let payload = body;

  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    payload = Buffer.from(payload).toString('utf8');
  }

  if (typeof payload === 'string') {
    payload = parseJson(
      payload,
      'TokenHub returned a successful response, but it was not valid JSON.'
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FriendlyError(
      'TokenHub returned a successful response, but it was not a valid JSON object.'
    );
  }

  const errorMessage = apiErrorMessage(payload, apiKey);
  if (errorMessage) {
    throw new FriendlyError(`TokenHub returned an API error: ${errorMessage}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new FriendlyError('TokenHub returned a response, but no message content was found.');
  }

  const usage =
    payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
      ? payload.usage
      : null;
  const finishReason = payload.choices?.[0]?.finish_reason ?? null;

  return { text: content, usage, finishReason };
}

async function* iterateStream(stream) {
  if (!stream) {
    throw new FriendlyError('TokenHub returned a streaming response without a response body.');
  }

  if (
    stream.body &&
    (typeof stream.body[Symbol.asyncIterator] === 'function' ||
      typeof stream.body.getReader === 'function')
  ) {
    stream = stream.body;
  }

  if (typeof stream[Symbol.asyncIterator] === 'function') {
    yield* stream;
    return;
  }

  if (typeof stream[Symbol.iterator] === 'function') {
    yield* stream;
    return;
  }

  if (typeof stream.getReader !== 'function') {
    throw new FriendlyError('TokenHub returned an unreadable streaming response body.');
  }

  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function decodeChunk(decoder, chunk) {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (chunk instanceof ArrayBuffer) {
    return decoder.decode(new Uint8Array(chunk), { stream: true });
  }

  if (ArrayBuffer.isView(chunk)) {
    return decoder.decode(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      { stream: true }
    );
  }

  throw new FriendlyError('TokenHub returned an unreadable chunk in its streaming response.');
}

/**
 * Incrementally consume a TokenHub SSE response body.
 */
async function consumeSseStream(stream, options = {}) {
  if (typeof options === 'function') {
    options = { onText: options };
  }

  const { onText, apiKey, signal } = options;
  if (onText !== undefined && typeof onText !== 'function') {
    throw new FriendlyError('The streaming text handler must be a function.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = null;
  let sawDone = false;
  let eventType = '';

  async function processLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.length === 0) {
      eventType = '';
      return;
    }

    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
      return;
    }

    if (!line.startsWith('data:')) {
      return;
    }

    const data = line.slice('data:'.length).trim();
    if (!data) {
      return;
    }

    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

    const payload = parseJson(
      data,
      'TokenHub returned invalid JSON in its streaming response.'
    );
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new FriendlyError('TokenHub returned an invalid event in its streaming response.');
    }

    const errorMessage =
      apiErrorMessage(payload, apiKey) ||
      (eventType === 'error'
        ? redactSecrets(payload.message || payload.detail || 'Unknown API error', apiKey)
        : null);
    if (errorMessage) {
      throw new FriendlyError(`TokenHub returned an API error: ${errorMessage}`);
    }

    if (
      payload.usage &&
      typeof payload.usage === 'object' &&
      !Array.isArray(payload.usage)
    ) {
      usage = payload.usage;
    }

    const eventFinishReason = payload.choices?.[0]?.finish_reason;
    if (eventFinishReason !== undefined && eventFinishReason !== null) {
      finishReason = eventFinishReason;
    }

    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      text += content;
      if (onText) {
        await onText(content);
      }
    }
  }

  function throwIfCancelled() {
    if (signal?.aborted) {
      throw new FriendlyError('TokenHub request was cancelled.');
    }
  }

  throwIfCancelled();

  for await (const chunk of iterateStream(stream)) {
    throwIfCancelled();
    buffer += decodeChunk(decoder, chunk);

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await processLine(line);
      if (sawDone) {
        break;
      }
    }

    if (sawDone) {
      break;
    }
  }

  if (!sawDone) {
    buffer += decoder.decode();
    if (buffer.length > 0) {
      await processLine(buffer);
    }
  }

  throwIfCancelled();

  if (!sawDone) {
    throw new FriendlyError(
      'TokenHub streaming response ended before the [DONE] event. The report may be incomplete.'
    );
  }

  if (text.trim().length === 0) {
    throw new FriendlyError('TokenHub returned a response, but no message content was found.');
  }

  return { text, usage, finishReason };
}

function safeErrorDetail(error, apiKey) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return redactSecrets(message, apiKey);
}

function formatHttpErrorBody(bodyText, apiKey) {
  if (!bodyText) {
    return '(empty)';
  }

  let detail = bodyText;
  try {
    const payload = JSON.parse(bodyText);
    detail = apiErrorMessage(payload, apiKey) || bodyText;
  } catch (_error) {
    // A non-JSON error page is still useful after redaction and truncation.
  }

  const safe = redactSecrets(detail, apiKey);
  if (safe.length <= MAX_ERROR_TEXT_LENGTH) {
    return safe;
  }
  return `${safe.slice(0, MAX_ERROR_TEXT_LENGTH)}...`;
}

/**
 * Send a Chat Completions request and return the generated text, usage, and finish reason.
 */
async function requestChatCompletion({
  messages,
  apiKey,
  stream = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature = 0.3,
  maxTokens = 600,
  responseFormat,
  onText,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  model = MODEL,
  maxRetries = DEFAULT_MAX_RETRIES,
  onRetry,
  sleepImpl = sleepWithSignal,
  random = Math.random
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new FriendlyError('Missing TokenHub API key.');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new FriendlyError('Request timeout must be a positive, reasonable number of milliseconds.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new FriendlyError('This Node.js runtime does not provide a usable fetch implementation.');
  }

  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new FriendlyError('Provider retry count must be a whole number from 0 to 5.');
  }

  const config = resolveProviderConfig({ baseUrl, model });

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let externalAbortHandler;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal) {
    externalAbortHandler = () => {
      externallyAborted = true;
      controller.abort();
    };

    if (signal.aborted) {
      externalAbortHandler();
    } else {
      signal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  try {
    if (externallyAborted) {
      throw new FriendlyError('TokenHub request was cancelled.');
    }

    const requestBody = {
      model: config.model,
      messages,
      temperature,
      max_tokens: maxTokens
    };

    if (responseFormat !== undefined) {
      if (
        !responseFormat ||
        typeof responseFormat !== 'object' ||
        Array.isArray(responseFormat) ||
        responseFormat.type !== 'json_object'
      ) {
        throw new FriendlyError('Provider response format must be { type: "json_object" }.');
      }
      requestBody.response_format = { type: 'json_object' };
    }

    if (stream) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const providerError = networkProviderError(error, apiKey);
        if (providerError.retryable && attempt < maxRetries) {
          const delayMs = retryDelayMs(attempt, null, random);
          notifyRetry(onRetry, { attempt: attempt + 1, maxRetries, delayMs, code: providerError.code });
          await sleepImpl(delayMs, controller.signal);
          continue;
        }
        throw providerError;
      }

      if (!response || typeof response.ok !== 'boolean') {
        throw new ProviderError('TokenHub returned an invalid HTTP response.', {
          code: 'MALFORMED_RESPONSE'
        });
      }

      if (!response.ok) {
        const providerError = await responseProviderError(response, apiKey, controller.signal);
        if (providerError.retryable && attempt < maxRetries) {
          const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
          const delayMs = retryDelayMs(attempt, retryAfter, random);
          notifyRetry(onRetry, { attempt: attempt + 1, maxRetries, delayMs, code: providerError.code });
          await sleepImpl(delayMs, controller.signal);
          continue;
        }
        throw providerError;
      }

      let result;
      if (stream) {
        result = await consumeSseStream(response.body, {
          onText,
          apiKey,
          signal: controller.signal
        });
      } else {
        const bodyText = await response.text();
        result = parseNonStreamingResponse(bodyText, apiKey);
      }
      const requestId = responseRequestId(response);
      return requestId ? { ...result, requestId } : result;
    }

    throw new ProviderError('TokenHub retry budget was exhausted.', {
      code: 'RETRY_EXHAUSTED'
    });
  } catch (error) {
    if (timedOut) {
      throw new FriendlyError(
        `TokenHub request timed out after ${timeoutMs / 1_000} seconds. Try again or increase --timeout.`
      );
    }

    if (externallyAborted || (controller.signal.aborted && error?.name === 'AbortError')) {
      throw new FriendlyError('TokenHub request was cancelled.');
    }

    if (error instanceof FriendlyError) {
      const SafeError = error instanceof ProviderError ? ProviderError : FriendlyError;
      throw new SafeError(redactSecrets(error.message, apiKey), {
        code: error.code,
        status: error.status,
        retryable: error.retryable
      });
    }

    if (error?.name === 'AbortError') {
      throw new FriendlyError('TokenHub request was cancelled.');
    }

    const detail = safeErrorDetail(error, apiKey);
    throw new FriendlyError(
      `Network error while calling TokenHub: ${detail}. Check your connection and try again.`
    );
  } finally {
    clearTimeout(timer);
    if (signal && externalAbortHandler) {
      signal.removeEventListener?.('abort', externalAbortHandler);
    }
  }
}

function resolveProviderConfig({ baseUrl = DEFAULT_BASE_URL, model = MODEL } = {}) {
  if (typeof model !== 'string' || !model.trim() || model.length > 128) {
    throw new FriendlyError('HY3_MODEL must be a non-empty model identifier of at most 128 characters.');
  }

  let url;
  try {
    url = new URL(String(baseUrl));
  } catch (_error) {
    throw new FriendlyError('HY3_BASE_URL must be a valid absolute URL.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new FriendlyError('HY3_BASE_URL must not contain credentials, a query string, or a fragment.');
  }
  const normalizedHostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(normalizedHostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new FriendlyError('HY3_BASE_URL must use HTTPS (HTTP is allowed only for a loopback test server).');
  }

  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath || '/v1';
  const normalizedBaseUrl = url.toString().replace(/\/$/, '');
  const endpoint = normalizedBaseUrl.endsWith('/chat/completions')
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/chat/completions`;

  return { baseUrl: normalizedBaseUrl, endpoint, model: model.trim() };
}

async function responseProviderError(response, apiKey, signal) {
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    bodyText = `Unable to read error response body: ${safeErrorDetail(error, apiKey)}`;
  }

  const status = Number.isInteger(response.status) ? response.status : null;
  const statusText = response.statusText
    ? ` ${redactSecrets(response.statusText, apiKey)}`
    : '';
  const safeBody = formatHttpErrorBody(bodyText, apiKey);
  const providerCode = extractProviderErrorCode(bodyText);
  const classification = classifyProviderFailure(status, safeBody, providerCode);
  return new ProviderError(
    `TokenHub returned HTTP ${status ?? 'unknown'}${statusText}.\nResponse body:\n${safeBody}`,
    { ...classification, status }
  );
}

function classifyProviderFailure(status, detail = '', providerCode = null) {
  const normalized = String(detail).toLowerCase();
  const numericCode = Number(providerCode);
  if (numericCode >= 401001 && numericCode <= 401005) {
    return { code: 'AUTHENTICATION_FAILED', retryable: false };
  }
  if ([400004, 400005, 403002].includes(numericCode)) {
    return { code: 'MODEL_UNAVAILABLE', retryable: false };
  }
  if (numericCode === 403005) {
    return { code: 'ACCESS_DENIED', retryable: false };
  }
  if (numericCode >= 429001 && numericCode <= 429006) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if ([500001, 502001, 503001, 504001].includes(numericCode)) {
    return { code: 'ENDPOINT_UNAVAILABLE', retryable: true };
  }
  if (numericCode === 499001) {
    return { code: 'CANCELLED', retryable: false };
  }
  if (status === 401 || status === 403) {
    return { code: 'AUTHENTICATION_FAILED', retryable: false };
  }
  if (/region|地域|区域/.test(normalized) && /mismatch|wrong|invalid|not available|不可用|错误/.test(normalized)) {
    return { code: 'REGION_MISMATCH', retryable: false };
  }
  if (
    (status === 400 || status === 404 || status === 422) &&
    /model|模型/.test(normalized) &&
    /not found|unavailable|unsupported|invalid|不存在|不可用|不支持/.test(normalized)
  ) {
    return { code: 'MODEL_UNAVAILABLE', retryable: false };
  }
  if (status === 408) return { code: 'PROVIDER_TIMEOUT', retryable: true };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if ([502, 503, 504].includes(status)) {
    return { code: 'ENDPOINT_UNAVAILABLE', retryable: true };
  }
  if (status === 404) return { code: 'ENDPOINT_UNAVAILABLE', retryable: false };
  if (status === 400 || status === 422) {
    return { code: 'MALFORMED_REQUEST', retryable: false };
  }
  return { code: 'PROVIDER_HTTP_ERROR', retryable: false };
}

function extractProviderErrorCode(bodyText) {
  try {
    const payload = JSON.parse(bodyText);
    const code = payload?.error?.code ?? payload?.code;
    return typeof code === 'number' || typeof code === 'string' ? code : null;
  } catch (_error) {
    return null;
  }
}

function networkProviderError(error, apiKey) {
  const detail = safeErrorDetail(error, apiKey);
  const code = error?.code === 'ENOTFOUND' ? 'ENDPOINT_UNAVAILABLE' : 'TEMPORARY_NETWORK_FAILURE';
  return new ProviderError(
    `Network error while calling TokenHub: ${detail}. Check the endpoint and connection.`,
    { code, retryable: true }
  );
}

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    return Math.max(0, Math.round(Number(value) * 1_000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

function retryDelayMs(attempt, retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfterMs));
  }
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** attempt));
  const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random())));
  return Math.min(MAX_RETRY_DELAY_MS, exponential + jitter);
}

function sleepWithSignal(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function notifyRetry(listener, event) {
  if (typeof listener === 'function') listener(event);
}

function responseRequestId(response) {
  const candidates = ['x-request-id', 'request-id', 'x-tencent-request-id'];
  for (const name of candidates) {
    const value = response.headers?.get?.(name);
    if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  }
  return null;
}

function createTokenHubProvider(config) {
  return {
    generate({ messages, stream, timeoutMs, signal, onChunk }) {
      return requestChatCompletion({
        ...config,
        messages,
        stream,
        timeoutMs,
        signal,
        onText: onChunk
      });
    }
  };
}

async function requestModelList({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 15_000,
  signal,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new FriendlyError('Missing TokenHub API key.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new FriendlyError('Preflight timeout must be a positive, reasonable number of milliseconds.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new FriendlyError('This Node.js runtime does not provide a usable fetch implementation.');
  }

  const config = resolveProviderConfig({ baseUrl, model: MODEL });
  const modelsEndpoint = config.baseUrl.endsWith('/chat/completions')
    ? `${config.baseUrl.slice(0, -'/chat/completions'.length)}/models`
    : `${config.baseUrl}/models`;
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    const response = await fetchImpl(modelsEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response || typeof response.ok !== 'boolean') {
      throw new ProviderError('TokenHub returned an invalid model-list response.', {
        code: 'MALFORMED_RESPONSE'
      });
    }
    if (!response.ok) {
      throw await responseProviderError(response, apiKey, controller.signal);
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch (_error) {
      throw new ProviderError('TokenHub model-list response was not valid JSON.', {
        code: 'MALFORMED_RESPONSE'
      });
    }
    if (!payload || payload.object !== 'list' || !Array.isArray(payload.data)) {
      throw new ProviderError('TokenHub model-list response did not match the documented list shape.', {
        code: 'MALFORMED_RESPONSE'
      });
    }

    const models = payload.data.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = typeof item.id === 'string' ? item.id : null;
      const name = typeof item.name === 'string' ? item.name : null;
      const status = typeof item.status === 'string' ? item.status : null;
      return id || name ? { id, name, status } : null;
    }).filter(Boolean);
    return { models, requestId: responseRequestId(response) };
  } catch (error) {
    if (timedOut) {
      throw new ProviderError(`TokenHub model-list preflight timed out after ${timeoutMs / 1_000} seconds.`, {
        code: 'PROVIDER_TIMEOUT'
      });
    }
    if (externallyAborted || error?.name === 'AbortError') {
      throw new ProviderError('TokenHub model-list preflight was cancelled.', {
        code: 'CANCELLED'
      });
    }
    if (error instanceof FriendlyError) {
      throw error;
    }
    throw networkProviderError(error, apiKey);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  TOKENHUB_ENDPOINT,
  MODEL,
  DEFAULT_TIMEOUT_MS,
  FriendlyError,
  ProviderError,
  classifyProviderFailure,
  createTokenHubProvider,
  redactSecrets,
  resolveProviderConfig,
  parseRetryAfter,
  retryDelayMs,
  sleepWithSignal,
  parseNonStreamingResponse,
  consumeSseStream,
  requestModelList,
  requestChatCompletion
};
