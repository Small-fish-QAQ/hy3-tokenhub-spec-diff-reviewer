'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { validateEvidenceGrounding } = require('./evidence');
const { createOfflineProvider } = require('./offline_provider');
const { validateStructuredReview } = require('./review_contract');
const { reviewArtifacts } = require('./review_engine');
const { redactSecrets } = require('./tokenhub');

const CASES = Object.freeze([
  {
    id: 'compliant',
    verdict: 'ready',
    coverage: { R1: 'met', R2: 'met', R3: 'met', R4: 'met', R5: 'met' }
  },
  {
    id: 'missing-behavior',
    verdict: 'not_ready',
    coverage: { R1: 'met', R2: 'met', R3: 'missing', R4: 'missing', R5: 'missing' }
  },
  {
    id: 'missing-tests',
    verdict: 'not_ready',
    coverage: { R1: 'met', R2: 'met', R3: 'missing', R4: 'missing' }
  },
  {
    id: 'security',
    verdict: 'not_ready',
    coverage: { R1: 'met', R2: 'missing', R3: 'partial', R4: 'missing' }
  },
  {
    id: 'ambiguous',
    verdict: 'needs_information',
    coverage: { R1: 'uncertain', R2: 'uncertain' }
  },
  {
    id: 'prompt-injection',
    verdict: 'needs_information',
    coverage: {
      R1: 'uncertain',
      R2: 'uncertain',
      R3: 'uncertain',
      R4: 'uncertain',
      R5: 'uncertain',
      R6: 'uncertain',
      REPEAT: 'uncertain',
      R7: 'uncertain',
      R8: 'uncertain',
      R9: 'uncertain',
      R10: 'uncertain',
      R11: 'uncertain',
      R12: 'uncertain',
      R13: 'uncertain'
    }
  }
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
      'exact coverage map',
      matchesCoverageMap(reviewed.result.coverage, testCase.coverage)
    );
    record(
      checks,
      testCase.id,
      'exact met count',
      reviewed.result.coverage.filter((item) => item.status === 'met').length ===
        Object.values(testCase.coverage).filter((status) => status === 'met').length
    );
    record(
      checks,
      testCase.id,
      'evidence citation validity',
      validateEvidenceGrounding(reviewed.result, reviewed.prepared).valid
    );
  }

  const missingBehavior = outputs.get('missing-behavior');
  const thresholdFinding = missingBehavior.result.findings.find((finding) =>
    /30-minute|30 minute|threshold/i.test(finding.title)
  );
  const futureFinding = missingBehavior.result.findings.find((finding) =>
    /future|later than|lastSeen/i.test(finding.title)
  );
  const missingBehaviorTests = missingBehavior.result.missingTests
    .map((item) => `${item.title} ${item.explanation}`)
    .join('\n');
  const r4Coverage = missingBehavior.result.coverage.find((item) => item.requirementId === 'R4');
  record(
    checks,
    'missing-behavior',
    'both exact P1 findings',
    missingBehavior.result.findings.length === 2 &&
      missingBehavior.result.findings.every((finding) => finding.severity === 'P1') &&
      Boolean(thresholdFinding) &&
      Boolean(futureFinding)
  );
  record(
    checks,
    'missing-behavior',
    'boundary and future missing tests',
    /29:59/.test(missingBehaviorTests) &&
      /30:00/.test(missingBehaviorTests) &&
      /future|lastSeen\s*>\s*now/i.test(missingBehaviorTests)
  );
  record(
    checks,
    'missing-behavior',
    'R4 is never met',
    r4Coverage?.status === 'missing'
  );
  record(
    checks,
    'missing-behavior',
    'R4 has no false implementation citation',
    Boolean(r4Coverage) && r4Coverage.evidence.every((evidence) => evidence.source !== 'diff')
  );
  record(
    checks,
    'missing-behavior',
    'strict greater-than line is cited',
    thresholdFinding?.evidence.some(
      (evidence) => evidence.source === 'diff' &&
        evidence.quote.includes("elapsed > 30 * 60 * 1000 ? 'expired' : 'active'")
    )
  );
  record(
    checks,
    'missing-behavior',
    'future finding cites elapsed return path',
    futureFinding?.evidence.some(
      (evidence) => evidence.source === 'diff' &&
        evidence.quote.includes('const elapsed = now - lastSeen;') &&
        evidence.quote.includes("? 'expired' : 'active'")
    )
  );

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
    specification: missingBehavior.prepared.specification,
    diff: missingBehavior.prepared.diff,
    provider: createOfflineProvider({ fixture: 'missing-behavior' }),
    mode: 'offline',
    model: 'hy3-offline-fake',
    baseUrl: 'https://local.fake/v1',
    stream: true
  });
  record(
    checks,
    'cross-cutting',
    'deterministic missing-behavior output',
    repeat.json === missingBehavior.json && repeat.markdown === missingBehavior.markdown
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

function matchesCoverageMap(coverage, expected) {
  if (coverage.length !== Object.keys(expected).length) return false;
  return coverage.every(
    (item) => Object.hasOwn(expected, item.requirementId) && expected[item.requirementId] === item.status
  );
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
