'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderError,
  classifyProviderFailure,
  parseRetryAfter,
  requestChatCompletion,
  resolveProviderConfig,
  retryDelayMs
} = require('../lib/tokenhub');

function headers(values = {}) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    }
  };
}

function success(content = '{}', headerValues = {}) {
  return {
    ok: true,
    status: 200,
    headers: headers(headerValues),
    async text() {
      return JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 }
      });
    }
  };
}

function failure(status, body, headerValues = {}) {
  return {
    ok: false,
    status,
    statusText: 'Synthetic failure',
    headers: headers(headerValues),
    async text() { return JSON.stringify(body); }
  };
}

test('provider configuration supports official regions and rejects credentialed or insecure URLs', () => {
  assert.deepEqual(resolveProviderConfig({
    baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1/',
    model: 'hy3'
  }), {
    baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1',
    endpoint: 'https://tokenhub-intl.tencentmaas.com/v1/chat/completions',
    model: 'hy3'
  });
  assert.throws(() => resolveProviderConfig({ baseUrl: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => resolveProviderConfig({ baseUrl: 'https://user:secret@example.com/v1' }), /credentials/);
  assert.doesNotThrow(() => resolveProviderConfig({ baseUrl: 'http://127.0.0.1:3000/v1' }));
});

test('transient 503 response retries once with bounded visible backoff then succeeds', async () => {
  let calls = 0;
  const sleeps = [];
  const retries = [];
  const result = await requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    stream: false,
    random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? failure(503, { error: { code: 503001, message: 'temporary upstream failure' } })
        : success('{"ok":true}');
    },
    sleepImpl: async (delay) => { sleeps.push(delay); },
    onRetry: (event) => retries.push(event)
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].code, 'ENDPOINT_UNAVAILABLE');
  assert.equal(result.finishReason, 'stop');
});

test('valid Retry-After seconds are respected within the bounded retry window', async () => {
  let calls = 0;
  const sleeps = [];
  await requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    stream: false,
    fetchImpl: async () => (++calls === 1
      ? failure(429, { error: { code: 429001, message: 'slow down' } }, { 'retry-after': '1.5' })
      : success()),
    sleepImpl: async (delay) => sleeps.push(delay)
  });
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(parseRetryAfter('1.5'), 1_500);
});

test('authentication, unsupported model, malformed request, and provider cancellation never retry', async (t) => {
  const cases = [
    [401, { error: { code: 401001, message: 'bad key' } }, 'AUTHENTICATION_FAILED'],
    [400, { error: { code: 400004, message: 'model missing' } }, 'MODEL_UNAVAILABLE'],
    [400, { error: { code: 400001, message: 'bad field' } }, 'MALFORMED_REQUEST'],
    [499, { error: { code: 499001, message: 'cancelled' } }, 'CANCELLED']
  ];
  for (const [status, body, code] of cases) {
    await t.test(code, async () => {
      let calls = 0;
      await assert.rejects(requestChatCompletion({
        apiKey: 'synthetic',
        messages: [],
        stream: false,
        fetchImpl: async () => { calls += 1; return failure(status, body); }
      }), (error) => error instanceof ProviderError && error.code === code);
      assert.equal(calls, 1);
    });
  }
});

test('official 500001 is a selected retryable server failure but retry count stays bounded', async () => {
  let calls = 0;
  await assert.rejects(requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    stream: false,
    maxRetries: 2,
    fetchImpl: async () => {
      calls += 1;
      return failure(500, { error: { code: 500001, message: 'internal transient' } });
    },
    sleepImpl: async () => {}
  }), (error) => error.code === 'ENDPOINT_UNAVAILABLE');
  assert.equal(calls, 3);
});

test('temporary network failure retries and known secrets are redacted after exhaustion', async () => {
  let calls = 0;
  await assert.rejects(requestChatCompletion({
    apiKey: 'network-secret-key',
    messages: [],
    stream: false,
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      const error = new Error('socket reset network-secret-key');
      error.code = 'ECONNRESET';
      throw error;
    },
    sleepImpl: async () => {}
  }), (error) => {
    assert.equal(error.code, 'TEMPORARY_NETWORK_FAILURE');
    assert.doesNotMatch(error.message, /network-secret-key/);
    return true;
  });
  assert.equal(calls, 2);
});

test('cancellation during backoff stops retrying and leaves no dangling delay', async () => {
  const controller = new AbortController();
  let calls = 0;
  let sleepStarted = false;
  await assert.rejects(requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    stream: false,
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      return failure(503, { error: { code: 503001, message: 'temporary' } });
    },
    onRetry() { controller.abort(); },
    sleepImpl: async (_delay, signal) => {
      sleepStarted = true;
      assert.equal(signal.aborted, true);
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  }), /cancelled/);
  assert.equal(sleepStarted, true);
  assert.equal(calls, 1);
});

test('safe provider request ID is retained and unsafe header values are discarded', async () => {
  const safe = await requestChatCompletion({
    apiKey: 'synthetic', messages: [], stream: false,
    fetchImpl: async () => success('{}', { 'x-request-id': 'req_123-safe' })
  });
  assert.equal(safe.requestId, 'req_123-safe');
  const unsafe = await requestChatCompletion({
    apiKey: 'synthetic', messages: [], stream: false,
    fetchImpl: async () => success('{}', { 'x-request-id': 'bad id\nsecret' })
  });
  assert.equal(Object.hasOwn(unsafe, 'requestId'), false);
});

test('live reviewer can request provider JSON-object output without weakening local validation', async () => {
  let requestBody;
  await requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    stream: false,
    responseFormat: { type: 'json_object' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return success('{}');
    }
  });
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  await assert.rejects(requestChatCompletion({
    apiKey: 'synthetic',
    messages: [],
    responseFormat: { type: 'json_schema' },
    fetchImpl: async () => success('{}')
  }), /response format/);
});

test('retry helpers classify official errors and cap exponential delay', () => {
  assert.deepEqual(classifyProviderFailure(400, '', 400005), {
    code: 'MODEL_UNAVAILABLE', retryable: false
  });
  assert.deepEqual(classifyProviderFailure(502, '', 502001), {
    code: 'ENDPOINT_UNAVAILABLE', retryable: true
  });
  assert.equal(retryDelayMs(10, null, () => 1), 30_000);
  assert.equal(retryDelayMs(0, 9_000), 9_000);
});
