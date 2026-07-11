'use strict';

const { TextDecoder } = require('node:util');

const TOKENHUB_ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/chat/completions';
const MODEL = 'hy3';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_ERROR_TEXT_LENGTH = 2_000;

class FriendlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FriendlyError';
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
  onText,
  signal,
  fetchImpl = globalThis.fetch
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
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens
    };

    if (stream) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }

    const response = await fetchImpl(TOKENHUB_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response || typeof response.ok !== 'boolean') {
      throw new FriendlyError('TokenHub returned an invalid HTTP response.');
    }

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        bodyText = `Unable to read error response body: ${safeErrorDetail(error, apiKey)}`;
      }

      const status = Number.isInteger(response.status) ? response.status : 'unknown';
      const statusText = response.statusText
        ? ` ${redactSecrets(response.statusText, apiKey)}`
        : '';
      const safeBody = formatHttpErrorBody(bodyText, apiKey);
      throw new FriendlyError(
        `TokenHub returned HTTP ${status}${statusText}.\nResponse body:\n${safeBody}`
      );
    }

    if (stream) {
      return await consumeSseStream(response.body, {
        onText,
        apiKey,
        signal: controller.signal
      });
    }

    const bodyText = await response.text();
    return parseNonStreamingResponse(bodyText, apiKey);
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
      throw new FriendlyError(redactSecrets(error.message, apiKey));
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

module.exports = {
  TOKENHUB_ENDPOINT,
  MODEL,
  DEFAULT_TIMEOUT_MS,
  FriendlyError,
  redactSecrets,
  parseNonStreamingResponse,
  consumeSseStream,
  requestChatCompletion
};
