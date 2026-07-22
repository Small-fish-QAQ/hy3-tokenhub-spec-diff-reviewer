'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOfflineResult, createOfflineProvider } = require('../lib/offline_provider');
const { REPAIR_TIMEOUT_MS, reviewArtifacts } = require('../lib/review_engine');

function loadFixture(id) {
  const directory = path.resolve(__dirname, '..', 'samples', 'offline', id);
  return {
    specification: fs.readFileSync(path.join(directory, 'spec.md'), 'utf8'),
    diff: fs.readFileSync(path.join(directory, 'change.diff'), 'utf8')
  };
}

const COMPLIANT_FIXTURE = loadFixture('compliant');
const MISSING_TESTS_FIXTURE = loadFixture('missing-tests');
const SPEC = COMPLIANT_FIXTURE.specification;
const DIFF = COMPLIANT_FIXTURE.diff;

test('validated result, Markdown, JSON, and provenance describe the same review', async () => {
  const events = [];
  const reviewed = await reviewArtifacts({
    specification: SPEC,
    diff: DIFF,
    provider: createOfflineProvider({ fixture: 'compliant' }),
    mode: 'offline',
    model: 'hy3-offline-fake',
    baseUrl: 'https://local.fake/v1',
    stream: true,
    onProgress: (event) => events.push(event.stage)
  });
  const artifact = JSON.parse(reviewed.json);
  assert.deepEqual(artifact.result, reviewed.result);
  assert.deepEqual(artifact.provenance, reviewed.provenance);
  assert.match(reviewed.markdown, /## READY/);
  assert.match(reviewed.markdown, /OFFLINE \/ FAKE/);
  assert.deepEqual(reviewed.provenance.validation, { schema: 'passed', evidence: 'passed' });
  for (const stage of [
    'validating_inputs', 'preparing_specification', 'reading_diff', 'calling_provider',
    'validating_schema', 'verifying_evidence', 'rendering_report'
  ]) assert.ok(events.includes(stage));
});

test('one malformed result can be repaired exactly once with bounded, evidence-scoped context', async () => {
  const calls = [];
  const provider = {
    async generate(options) {
      calls.push(options);
      if (options.purpose === 'review') return { text: '{bad', finishReason: 'stop' };
      return {
        text: JSON.stringify(buildOfflineResult('compliant', options.prepared)),
        finishReason: 'stop'
      };
    }
  };
  const reviewed = await reviewArtifacts({
    specification: SPEC,
    diff: DIFF,
    provider,
    mode: 'live',
    model: 'hy3',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    timeoutMs: 120_000
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].purpose, 'repair');
  assert.equal(calls[1].stream, false);
  assert.equal(calls[1].timeoutMs, REPAIR_TIMEOUT_MS);
  const repairPayload = JSON.parse(calls[1].messages[1].content);
  assert.equal(repairPayload.invalidOutput, '{bad');
  assert.ok(repairPayload.validationErrors.length > 0);
  assert.ok(repairPayload.allowedEvidence.specification.requirements.length > 0);
  assert.equal(reviewed.provenance.provider.repairAttempted, true);
});

test('a failed repair stops after two provider calls and returns no completed value', async () => {
  let calls = 0;
  await assert.rejects(reviewArtifacts({
    specification: SPEC,
    diff: DIFF,
    provider: async () => {
      calls += 1;
      return { text: '{still bad', finishReason: 'stop' };
    },
    mode: 'live'
  }), /single bounded repair attempt/);
  assert.equal(calls, 2);
});

test('schema-valid fabricated evidence can be repaired once before completion', async () => {
  let calls = 0;
  const provider = async ({ prepared }) => {
    calls += 1;
    const result = buildOfflineResult('compliant', prepared);
    if (calls === 1) {
      const evidence = result.coverage[0].evidence.find((item) => item.source === 'diff');
      evidence.path = 'src/invented.js';
    }
    return { text: JSON.stringify(result), finishReason: 'stop' };
  };
  const reviewed = await reviewArtifacts({ specification: SPEC, diff: DIFF, provider });
  assert.equal(calls, 2);
  assert.equal(reviewed.provenance.validation.evidence, 'passed');
});

test('truncated, content-filtered, and unexpected finishes fail without repair', async (t) => {
  for (const finishReason of ['length', 'content_filter', null, 'tool_calls']) {
    await t.test(String(finishReason), async () => {
      let calls = 0;
      await assert.rejects(reviewArtifacts({
        specification: SPEC,
        diff: DIFF,
        provider: async ({ prepared }) => {
          calls += 1;
          return { text: JSON.stringify(buildOfflineResult('compliant', prepared)), finishReason };
        }
      }), /truncated|content-filtered|unexpected finish/);
      assert.equal(calls, 1);
    });
  }
});

test('pre-aborted review stops before provider access and returns no completed output', async () => {
  const controller = new AbortController();
  controller.abort();
  let providerCalled = false;
  await assert.rejects(reviewArtifacts({
    specification: SPEC,
    diff: DIFF,
    signal: controller.signal,
    provider() { providerCalled = true; }
  }), (error) => error.exitCode === 130 && /cancelled/.test(error.message));
  assert.equal(providerCalled, false);
});

test('offline streaming is deterministic and traverses the same chunk callback path', async () => {
  async function execute() {
    const chunks = [];
    const reviewed = await reviewArtifacts({
      specification: MISSING_TESTS_FIXTURE.specification,
      diff: MISSING_TESTS_FIXTURE.diff,
      provider: createOfflineProvider({ fixture: 'missing-tests' }),
      mode: 'offline',
      model: 'hy3-offline-fake',
      stream: true,
      onProviderChunk: (chunk) => chunks.push(chunk)
    });
    return { reviewed, chunks };
  }
  const first = await execute();
  const second = await execute();
  assert.ok(first.chunks.length > 1);
  assert.equal(first.chunks.join(''), second.chunks.join(''));
  assert.equal(first.reviewed.json, second.reviewed.json);
  assert.equal(first.reviewed.provenance.mode, 'offline');
  assert.equal(first.reviewed.provenance.model, 'hy3-offline-fake');
});

test('unsafe provider request IDs and credentialed URLs never enter provenance', async () => {
  const reviewed = await reviewArtifacts({
    specification: SPEC,
    diff: DIFF,
    provider: async ({ prepared }) => ({
      text: JSON.stringify(buildOfflineResult('compliant', prepared)),
      finishReason: 'stop',
      requestId: 'bad request id with spaces'
    }),
    mode: 'live',
    model: 'hy3',
    baseUrl: 'https://username:secret@tokenhub.tencentmaas.com/v1'
  });
  assert.equal(reviewed.provenance.provider.requestId, null);
  assert.equal(reviewed.provenance.providerHost, 'tokenhub.tencentmaas.com');
  assert.doesNotMatch(reviewed.json, /username|secret@/);
});

test('core size limits apply equally to direct and browser callers', async () => {
  await assert.rejects(reviewArtifacts({
    specification: 'x'.repeat(512 * 1024 + 1),
    diff: DIFF,
    provider: createOfflineProvider({ fixture: 'compliant' })
  }), /Specification exceeds/);
});
