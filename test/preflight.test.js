'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkProvider, classifyPreflightCode } = require('../lib/preflight');
const { FriendlyError, ProviderError, requestModelList } = require('../lib/tokenhub');

test('preflight succeeds through documented GET /v1/models without sending artifact data', async () => {
  let received;
  const result = await checkProvider({
    apiKey: 'synthetic-key',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    model: 'hy3',
    requestImpl: async (options) => {
      received = options;
      return {
        models: [{ id: 'hy3', name: 'hy3', status: 'online' }],
        requestId: 'req-safe-123'
      };
    }
  });
  assert.equal(received.apiKey, 'synthetic-key');
  assert.equal(Object.hasOwn(received, 'messages'), false);
  assert.equal(result.ok, true);
  assert.equal(result.modelStatus, 'online');
  assert.match(result.operation, /GET \/v1\/models/);
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
});

test('preflight distinguishes authentication and includes an honest region hint', async () => {
  await assert.rejects(checkProvider({
    apiKey: 'secret-value',
    model: 'hy3',
    requestImpl: async () => {
      throw new ProviderError('401 key rejected: secret-value', { code: 'AUTHENTICATION_FAILED' });
    }
  }), (error) => {
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.match(error.message, /Authentication failed/);
    assert.match(error.message, /region-scoped/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test('preflight distinguishes unavailable, unlisted, and offline models', async (t) => {
  for (const models of [
    [{ id: 'other', name: 'other', status: 'online' }],
    [{ id: 'hy3', name: 'hy3', status: 'offline' }]
  ]) {
    await t.test(JSON.stringify(models), async () => {
      await assert.rejects(checkProvider({
        apiKey: 'synthetic',
        model: 'hy3',
        requestImpl: async () => ({ models })
      }), (error) => error.code === 'MODEL_UNAVAILABLE' && /Model unavailable/.test(error.message));
    });
  }
});

test('preflight reports explicit region mismatch without inferring it from generic auth failures', async () => {
  await assert.rejects(checkProvider({
    apiKey: 'synthetic',
    model: 'hy3',
    requestImpl: async () => {
      throw new ProviderError('key region does not match endpoint region', { code: 'REGION_MISMATCH' });
    }
  }), (error) => error.code === 'REGION_MISMATCH' && /region mismatch/i.test(error.message));
});

test('preflight classifies malformed response, timeout, endpoint, and malformed request outcomes', async (t) => {
  const cases = [
    [new ProviderError('bad shape', { code: 'MALFORMED_RESPONSE' }), 'MALFORMED_RESPONSE'],
    [new ProviderError('too slow', { code: 'PROVIDER_TIMEOUT' }), 'TIMEOUT'],
    [new ProviderError('unreachable', { code: 'ENDPOINT_UNAVAILABLE' }), 'ENDPOINT_UNAVAILABLE'],
    [new ProviderError('bad request', { code: 'MALFORMED_REQUEST' }), 'MALFORMED_REQUEST']
  ];
  for (const [failure, expected] of cases) {
    await t.test(expected, async () => {
      await assert.rejects(checkProvider({
        apiKey: 'synthetic',
        requestImpl: async () => { throw failure; }
      }), (error) => error.code === expected);
    });
  }
});

test('requestModelList uses bearer auth, parses documented shape, and retains only safe fields', async () => {
  let request;
  const result = await requestModelList({
    apiKey: 'synthetic-key',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        headers: { get(name) { return name === 'x-request-id' ? 'req-model-list' : null; } },
        async text() {
          return JSON.stringify({
            object: 'list',
            data: [{ id: 'hy3', name: 'Hy3', status: 'online', internalSecret: 'omit-me' }]
          });
        }
      };
    }
  });
  assert.equal(request.url, 'https://tokenhub.tencentmaas.com/v1/models');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-key');
  assert.deepEqual(result, {
    models: [{ id: 'hy3', name: 'Hy3', status: 'online' }],
    requestId: 'req-model-list'
  });
});

test('requestModelList rejects malformed JSON and malformed documented shapes', async (t) => {
  for (const body of ['{bad', JSON.stringify({ object: 'other', data: [] })]) {
    await t.test(body, async () => {
      await assert.rejects(requestModelList({
        apiKey: 'synthetic',
        fetchImpl: async () => ({ ok: true, headers: { get() {} }, async text() { return body; } })
      }), (error) => error.code === 'MALFORMED_RESPONSE');
    });
  }
});

test('requestModelList timeout aborts the pending request', async () => {
  let observedSignal;
  await assert.rejects(requestModelList({
    apiKey: 'synthetic',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  }), (error) => error.code === 'PROVIDER_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
});

test('preflight fallback classifier does not expose unknown error internals as a wrong-region claim', () => {
  assert.equal(classifyPreflightCode(new FriendlyError('generic auth-looking failure')), 'NETWORK_FAILURE');
});
