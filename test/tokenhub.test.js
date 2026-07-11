'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODEL,
  TOKENHUB_ENDPOINT,
  FriendlyError,
  consumeSseStream,
  parseNonStreamingResponse,
  redactSecrets,
  requestChatCompletion
} = require('../lib/tokenhub');

function buffers(...parts) {
  return parts.map((part) => Buffer.from(part, 'utf8'));
}

function dataEvent(payload, newline = '\n') {
  return `data: ${JSON.stringify(payload)}${newline}${newline}`;
}

function assertFriendlyError(error, pattern) {
  assert.ok(error instanceof FriendlyError);
  assert.match(error.message, pattern);
  return true;
}

test('redactSecrets removes known, bearer, and API-key-shaped credentials', () => {
  const knownSecret = 'known-secret-value';
  const input = [
    `request failed for ${knownSecret}`,
    'Authorization: Bearer bearer-secret',
    'api_key=api-secret',
    'TOKENHUB_API_KEY: tokenhub-secret'
  ].join('; ');

  const output = redactSecrets(input, knownSecret);

  for (const secret of [knownSecret, 'bearer-secret', 'api-secret', 'tokenhub-secret']) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /\[redacted\]/);
});

test('parseNonStreamingResponse returns complete content and usage', () => {
  const response = parseNonStreamingResponse(
    JSON.stringify({
      choices: [{ message: { content: '# Report\n\nReady' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    })
  );

  assert.deepEqual(response, {
    text: '# Report\n\nReady',
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    finishReason: 'stop'
  });
});

test('parseNonStreamingResponse returns a length finish reason', () => {
  assert.deepEqual(
    parseNonStreamingResponse({
      choices: [{ message: { content: 'Partial report' }, finish_reason: 'length' }]
    }),
    { text: 'Partial report', usage: null, finishReason: 'length' }
  );
});

test('parseNonStreamingResponse reports missing or null finish reason as null', () => {
  for (const choice of [
    { message: { content: 'Missing finish reason' } },
    { message: { content: 'Null finish reason' }, finish_reason: null }
  ]) {
    assert.deepEqual(
      parseNonStreamingResponse({ choices: [choice] }),
      { text: choice.message.content, usage: null, finishReason: null }
    );
  }
});

test('parseNonStreamingResponse rejects invalid JSON and missing content', () => {
  assert.throws(
    () => parseNonStreamingResponse('{not-json'),
    (error) => assertFriendlyError(error, /not valid JSON/)
  );
  assert.throws(
    () => parseNonStreamingResponse({ choices: [] }),
    (error) => assertFriendlyError(error, /no message content/)
  );
});

test('parseNonStreamingResponse redacts secrets in API errors', () => {
  const apiKey = 'offline-test-key';
  assert.throws(
    () =>
      parseNonStreamingResponse(
        { error: { message: `Rejected Bearer ${apiKey}` } },
        apiKey
      ),
    (error) => {
      assertFriendlyError(error, /TokenHub returned an API error/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    }
  );
});

test('consumeSseStream accumulates text incrementally and handles LF events', async () => {
  const emitted = [];
  const result = await consumeSseStream(
    buffers(
      dataEvent({ choices: [{ delta: { content: '# Report' }, finish_reason: null }] }),
      dataEvent({ choices: [{ delta: { content: '\nReady' }, finish_reason: null }] }),
      dataEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ),
    { onText: (text) => emitted.push(text) }
  );

  assert.deepEqual(emitted, ['# Report', '\nReady']);
  assert.deepEqual(result, {
    text: '# Report\nReady',
    usage: null,
    finishReason: 'stop'
  });
});

test('consumeSseStream returns a length finish reason', async () => {
  const stream = [
    dataEvent({ choices: [{ delta: { content: 'Partial report' }, finish_reason: null }] }),
    dataEvent({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    'data: [DONE]\n\n'
  ].join('');

  assert.deepEqual(await consumeSseStream(buffers(stream)), {
    text: 'Partial report',
    usage: null,
    finishReason: 'length'
  });
});

test('consumeSseStream handles CRLF and ignores harmless non-data fields', async () => {
  const stream = [
    ': keep-alive\r\n',
    'id: 123\r\n',
    'retry: 1000\r\n',
    dataEvent({ choices: [{ delta: { content: 'CRLF' } }] }, '\r\n'),
    'data: [DONE]\r\n\r\n'
  ].join('');

  assert.deepEqual(await consumeSseStream(buffers(stream)), {
    text: 'CRLF',
    usage: null,
    finishReason: null
  });
});

test('consumeSseStream handles an SSE line split across network chunks', async () => {
  const stream = [
    dataEvent({ choices: [{ delta: { content: 'split-line' } }] }),
    'data: [DONE]\n\n'
  ].join('');
  const boundaries = [5, 19, 33, stream.length - 3];
  const parts = [];
  let start = 0;
  for (const end of boundaries) {
    parts.push(stream.slice(start, end));
    start = end;
  }
  parts.push(stream.slice(start));

  assert.equal((await consumeSseStream(buffers(...parts))).text, 'split-line');
});

test('consumeSseStream handles multiple SSE events in one network chunk', async () => {
  const chunk = [
    dataEvent({ choices: [{ delta: { content: 'one' } }] }),
    dataEvent({ choices: [{ delta: { content: ' two' } }] }),
    dataEvent({ choices: [{ delta: { content: ' three' } }] }),
    'data: [DONE]\n\n'
  ].join('');

  assert.equal((await consumeSseStream(buffers(chunk))).text, 'one two three');
});

test('consumeSseStream safely ignores events without a text delta', async () => {
  const stream = [
    dataEvent({ choices: [{ delta: { role: 'assistant' } }] }),
    dataEvent({ choices: [] }),
    dataEvent({ choices: [{ delta: { content: null } }] }),
    dataEvent({ id: 'usage-only' }),
    dataEvent({ choices: [{ delta: { content: 'actual text' } }] }),
    'data: [DONE]\n\n'
  ].join('');

  assert.deepEqual(await consumeSseStream(buffers(stream)), {
    text: 'actual text',
    usage: null,
    finishReason: null
  });
});

test('consumeSseStream stops at [DONE] and ignores later input', async () => {
  const stream = [
    dataEvent({ choices: [{ delta: { content: 'before' } }] }),
    'data: [DONE]\n\n',
    dataEvent({ choices: [{ delta: { content: 'after' } }] })
  ].join('');

  assert.equal((await consumeSseStream(buffers(stream))).text, 'before');
});

test('consumeSseStream captures final usage', async () => {
  const usage = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 };
  const stream = [
    dataEvent({ choices: [{ delta: { content: 'Ready' } }] }),
    dataEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    dataEvent({ choices: [], usage }),
    'data: [DONE]\n\n'
  ].join('');

  assert.deepEqual(await consumeSseStream(buffers(stream)), {
    text: 'Ready',
    usage,
    finishReason: 'stop'
  });
});

test('consumeSseStream handles a remaining buffered [DONE] line', async () => {
  const stream = `${dataEvent({ choices: [{ delta: { content: 'complete' } }] })}data: [DONE]`;
  assert.equal((await consumeSseStream(buffers(stream))).text, 'complete');
});

test('consumeSseStream rejects invalid streaming JSON', async () => {
  await assert.rejects(
    consumeSseStream(buffers('data: {bad-json}\n\ndata: [DONE]\n\n')),
    (error) => assertFriendlyError(error, /invalid JSON in its streaming response/)
  );
});

test('consumeSseStream detects and redacts API error events', async () => {
  const apiKey = 'offline-stream-key';
  const stream = [
    'event: error\n',
    `data: ${JSON.stringify({ message: `Bearer ${apiKey} was rejected` })}\n\n`
  ].join('');

  await assert.rejects(consumeSseStream(buffers(stream), { apiKey }), (error) => {
    assertFriendlyError(error, /TokenHub returned an API error/);
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});

test('consumeSseStream rejects a stream that ends without [DONE]', async () => {
  const stream = [
    dataEvent({ choices: [{ delta: { content: 'partial' } }] }),
    dataEvent({ choices: [{ delta: {}, finish_reason: 'length' }] })
  ].join('');
  await assert.rejects(
    consumeSseStream(buffers(stream)),
    (error) => assertFriendlyError(error, /ended before the \[DONE\] event/)
  );
});

test('requestChatCompletion sends streaming flags and returns accumulated text', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      body: buffers(
        dataEvent({ choices: [{ delta: { content: 'streamed' } }] }),
        dataEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        dataEvent({ choices: [], usage: { total_tokens: 5 } }),
        'data: [DONE]\n\n'
      )
    };
  };

  const result = await requestChatCompletion({
    messages: [{ role: 'user', content: 'Review this.' }],
    apiKey: 'synthetic-test-key',
    fetchImpl,
    timeoutMs: 1000
  });
  const body = JSON.parse(request.options.body);

  assert.equal(request.url, TOKENHUB_ENDPOINT);
  assert.equal(request.options.method, 'POST');
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(result, {
    text: 'streamed',
    usage: { total_tokens: 5 },
    finishReason: 'stop'
  });
});

test('requestChatCompletion uses the normal non-streaming JSON path', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: 'non-streamed' }, finish_reason: 'stop' }],
          usage: { total_tokens: 7 }
        })
    };
  };

  const result = await requestChatCompletion({
    messages: [{ role: 'user', content: 'Review this.' }],
    apiKey: 'synthetic-test-key',
    stream: false,
    fetchImpl,
    timeoutMs: 1000
  });

  assert.equal(Object.hasOwn(requestBody, 'stream'), false);
  assert.equal(Object.hasOwn(requestBody, 'stream_options'), false);
  assert.deepEqual(result, {
    text: 'non-streamed',
    usage: { total_tokens: 7 },
    finishReason: 'stop'
  });
});

test('requestChatCompletion redacts secrets from HTTP failures', async () => {
  const apiKey = 'http-error-test-key';
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: `Unauthorized ${apiKey}`,
    text: async () => JSON.stringify({ error: { message: `Bearer ${apiKey} is invalid` } })
  });

  await assert.rejects(
    requestChatCompletion({
      messages: [{ role: 'user', content: 'Review this.' }],
      apiKey,
      stream: false,
      fetchImpl,
      timeoutMs: 1000
    }),
    (error) => {
      assertFriendlyError(error, /TokenHub returned HTTP 401/);
      assert.equal(error.message.includes(apiKey), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    }
  );
});

test('requestChatCompletion validates timeout without invoking fetch', async () => {
  let called = false;
  await assert.rejects(
    requestChatCompletion({
      messages: [],
      apiKey: 'synthetic-test-key',
      timeoutMs: 0,
      fetchImpl: async () => {
        called = true;
      }
    }),
    (error) => assertFriendlyError(error, /timeout must be a positive, reasonable number/)
  );
  assert.equal(called, false);
});

test('requestChatCompletion aborts a timed-out request with a friendly message', async () => {
  const fetchImpl = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('synthetic abort');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true }
      );
    });

  await assert.rejects(
    requestChatCompletion({
      messages: [],
      apiKey: 'synthetic-test-key',
      timeoutMs: 5,
      fetchImpl
    }),
    (error) => assertFriendlyError(error, /timed out after 0\.005 seconds/)
  );
});

test('requestChatCompletion reports a redacted HTTP error-body read failure', async () => {
  const apiKey = 'body-read-test-key';
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    text: async () => {
      throw new Error(`reader failed for ${apiKey}`);
    }
  });

  await assert.rejects(
    requestChatCompletion({
      messages: [],
      apiKey,
      stream: false,
      timeoutMs: 1000,
      fetchImpl
    }),
    (error) => {
      assertFriendlyError(error, /Unable to read error response body/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    }
  );
});
