'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { validateEvidenceGrounding } = require('./evidence');
const { createOfflineProvider } = require('./offline_provider');
const { validateStructuredReview } = require('./review_contract');
const { reviewArtifacts } = require('./review_engine');
const { redactSecrets } = require('./tokenhub');

const CASES = Object.freeze([
  { id: 'compliant', verdict: 'ready', coverage: 'met' },
  { id: 'missing-behavior', verdict: 'not_ready', coverage: 'missing' },
  { id: 'missing-tests', verdict: 'not_ready', coverage: 'missing' },
  { id: 'security', verdict: 'not_ready', coverage: 'partial' },
  { id: 'ambiguous', verdict: 'needs_information', coverage: 'uncertain' },
  { id: 'prompt-injection', verdict: 'needs_information', coverage: 'uncertain' }
]);

async function runOfflineEvaluation({ root = path.resolve(__dirname, '..') } = {}) {
  const checks = [];
  const outputs = new Map();

  for (const testCase of CASES) {
    const directory = path.join(root, 'samples', 'offline', testCase.id);
    const [specification, diff] = await Promise.all([
      fs.readFile(path.join(directory, 'spec.md'), 'utf8'),
      fs.readFile(path.join(directory, 'change.diff'), 'utf8')
    ]);
    const reviewed = await reviewArtifacts({
      specification,
      diff,
      provider: createOfflineProvider({ fixture: testCase.id }),
      mode: 'offline',
      model: 'hy3-offline-fake',
      baseUrl: 'https://local.fake/v1',
      stream: true
    });
    outputs.set(testCase.id, reviewed);

    record(checks, testCase.id, 'schema validity', validateStructuredReview(reviewed.result).valid);
    record(checks, testCase.id, 'expected verdict', reviewed.result.verdict === testCase.verdict);
    record(
      checks,
      testCase.id,
      'expected coverage status',
      reviewed.result.coverage.some((item) => item.status === testCase.coverage)
    );
    record(
      checks,
      testCase.id,
      'evidence citation validity',
      validateEvidenceGrounding(reviewed.result, reviewed.prepared).valid
    );
  }

  const compliant = outputs.get('compliant');
  const fabricated = structuredClone(compliant.result);
  fabricated.coverage[0].evidence.push({
    source: 'diff',
    path: 'src/fabricated.js',
    side: 'added',
    startLine: 999,
    endLine: 999,
    quote: 'fabricated'
  });
  record(
    checks,
    'cross-cutting',
    'fabricated evidence rejected',
    !validateEvidenceGrounding(fabricated, compliant.prepared).valid
  );

  const secret = 'sk-evaluation-secret-value';
  const redacted = redactSecrets(`Bearer ${secret}; api_key=${secret}`, secret);
  record(
    checks,
    'cross-cutting',
    'secret redaction',
    !redacted.includes(secret) && redacted.includes('[redacted]')
  );

  const injection = outputs.get('prompt-injection');
  const injectionEvidence = injection.result.coverage.flatMap((item) => item.evidence);
  record(
    checks,
    'cross-cutting',
    'prompt-injection resistance',
    injection.result.verdict === 'needs_information' &&
      injectionEvidence.every((evidence) => evidence.source !== 'diff' || evidence.path !== 'src/does-not-exist.js')
  );

  const repeat = await reviewArtifacts({
    specification: compliant.prepared.specification,
    diff: compliant.prepared.diff,
    provider: createOfflineProvider({ fixture: 'compliant' }),
    mode: 'offline',
    model: 'hy3-offline-fake',
    baseUrl: 'https://local.fake/v1',
    stream: true
  });
  record(
    checks,
    'cross-cutting',
    'deterministic offline output',
    repeat.json === compliant.json && repeat.markdown === compliant.markdown
  );

  const controller = new AbortController();
  controller.abort();
  let cancelledOutput = null;
  try {
    cancelledOutput = await reviewArtifacts({
      specification: compliant.prepared.specification,
      diff: compliant.prepared.diff,
      provider: createOfflineProvider({ fixture: 'compliant' }),
      mode: 'offline',
      signal: controller.signal
    });
  } catch (_error) {
    // Expected: an aborted review returns no publishable result.
  }
  record(checks, 'cross-cutting', 'no partial output after cancellation', cancelledOutput === null);

  let failedOutput = null;
  try {
    failedOutput = await reviewArtifacts({
      specification: compliant.prepared.specification,
      diff: compliant.prepared.diff,
      provider: async () => ({ text: '{bad', finishReason: 'stop' }),
      mode: 'offline',
      allowRepair: false
    });
  } catch (_error) {
    // Expected: invalid provider output returns no publishable result.
  }
  record(checks, 'cross-cutting', 'no partial output after validation failure', failedOutput === null);

  const passed = checks.filter((check) => check.passed).length;
  return {
    corpusCases: CASES.length,
    checks,
    passed,
    failed: checks.length - passed,
    ok: passed === checks.length
  };
}

function record(checks, fixture, name, passed) {
  checks.push({ fixture, name, passed: Boolean(passed) });
}

function formatEvaluation(result) {
  const lines = [
    'Hy3 OFFLINE / FAKE regression evaluation',
    '',
    '| Fixture | Check | Result |',
    '| --- | --- | --- |'
  ];
  for (const check of result.checks) {
    lines.push(`| ${check.fixture} | ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push(
    '',
    `Corpus: ${result.corpusCases} self-authored cases`,
    `Checks: ${result.passed}/${result.checks.length} passed; ${result.failed} failed`,
    '',
    'This is deterministic regression evidence, not a claim of semantic benchmark superiority.',
    ''
  );
  return lines.join('\n');
}

module.exports = {
  CASES,
  formatEvaluation,
  runOfflineEvaluation
};
