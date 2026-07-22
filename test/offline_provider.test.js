'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareReviewInputs, validateEvidenceGrounding } = require('../lib/evidence');
const { buildOfflineResult, createOfflineProvider, inferFixture } = require('../lib/offline_provider');
const { validateStructuredReview } = require('../lib/review_contract');
const { reviewArtifacts } = require('../lib/review_engine');

function loadFixture(id) {
  const directory = path.resolve(__dirname, '..', 'samples', 'offline', id);
  const specification = fs.readFileSync(path.join(directory, 'spec.md'), 'utf8');
  const diff = fs.readFileSync(path.join(directory, 'change.diff'), 'utf8');
  return { specification, diff, prepared: prepareReviewInputs(specification, diff) };
}

function statusMap(result) {
  return Object.fromEntries(result.coverage.map((item) => [item.requirementId, item.status]));
}

test('missing-behavior fixture has the exact two-of-five ground truth', () => {
  const { prepared } = loadFixture('missing-behavior');
  const result = buildOfflineResult('missing-behavior', prepared);

  assert.equal(result.verdict, 'not_ready');
  assert.deepEqual(statusMap(result), {
    R1: 'met',
    R2: 'met',
    R3: 'missing',
    R4: 'missing',
    R5: 'missing'
  });
  assert.equal(result.coverage.filter((item) => item.status === 'met').length, 2);
  assert.deepEqual(validateStructuredReview(result), { valid: true, errors: [] });
  assert.deepEqual(validateEvidenceGrounding(result, prepared), { valid: true, errors: [] });
});

test('missing-behavior findings cite the real threshold and future-timestamp return path', () => {
  const { prepared } = loadFixture('missing-behavior');
  const result = buildOfflineResult('missing-behavior', prepared);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every((finding) => finding.severity === 'P1'));

  const threshold = result.findings.find((finding) => /greater-than|30-minute/i.test(finding.title));
  const future = result.findings.find((finding) => /future.*lastSeen/i.test(finding.title));
  assert.ok(threshold);
  assert.ok(future);
  assert.ok(threshold.evidence.some((evidence) =>
    evidence.source === 'spec' && evidence.requirementId === 'R3' &&
    evidence.quote.includes('at or after exactly 30 minutes')
  ));
  assert.ok(threshold.evidence.some((evidence) =>
    evidence.source === 'diff' && evidence.path === 'src/session.js' &&
    evidence.startLine === 3 && evidence.endLine === 3 &&
    evidence.quote.includes("elapsed > 30 * 60 * 1000 ? 'expired' : 'active'")
  ));
  assert.ok(future.evidence.some((evidence) =>
    evidence.source === 'spec' && evidence.requirementId === 'R4' &&
    evidence.quote.includes('later than `now`')
  ));
  assert.ok(future.evidence.some((evidence) =>
    evidence.source === 'diff' && evidence.path === 'src/session.js' &&
    evidence.startLine === 2 && evidence.endLine === 3 &&
    evidence.quote.includes('const elapsed = now - lastSeen;') &&
    evidence.quote.includes("return elapsed > 30 * 60 * 1000 ? 'expired' : 'active';")
  ));
  assert.match(threshold.recommendation, />=|inclusive boundary/i);
  assert.match(future.recommendation, /lastSeen > now|future-timestamp/i);
});

test('R4 never receives the previous false MET status or declaration citation', () => {
  const { prepared } = loadFixture('missing-behavior');
  const result = buildOfflineResult('missing-behavior', prepared);
  const r4 = result.coverage.find((item) => item.requirementId === 'R4');

  assert.equal(r4.status, 'missing');
  assert.deepEqual(r4.evidence.map((evidence) => evidence.source), ['spec']);
  assert.doesNotMatch(JSON.stringify(r4), /export function sessionStatus/);
  assert.match(r4.explanation, /no future-timestamp rejection/i);
});

test('missing-behavior recommends both boundaries and future-lastSeen rejection tests', () => {
  const { prepared } = loadFixture('missing-behavior');
  const result = buildOfflineResult('missing-behavior', prepared);
  const text = result.missingTests.map((item) => `${item.title} ${item.explanation}`).join('\n');

  assert.equal(result.missingTests.length, 3);
  assert.match(text, /29:59/);
  assert.match(text, /30:00/);
  assert.match(text, /future lastSeen/i);
  assert.match(text, /lastSeen > now/);
});

test('named fixtures fail loudly on unknown requirements and changed evidence selectors', () => {
  const fixture = loadFixture('missing-behavior');
  const extraRequirement = prepareReviewInputs(
    `${fixture.specification}\n5. Log the status.\n`,
    fixture.diff
  );
  assert.throws(
    () => buildOfflineResult('missing-behavior', extraRequirement),
    /unrecognized requirement R6/
  );

  const renamedRequirement = prepareReviewInputs(
    fixture.specification.replace('later than `now`', 'after `now`'),
    fixture.diff
  );
  assert.throws(
    () => buildOfflineResult('missing-behavior', renamedRequirement),
    /expected 1 requirement.*found 0/
  );

  const changedDiff = prepareReviewInputs(
    fixture.specification,
    fixture.diff.replace('elapsed > 30 * 60 * 1000', 'elapsed >= 30 * 60 * 1000')
  );
  assert.throws(
    () => buildOfflineResult('missing-behavior', changedDiff),
    /expected one exact diff match.*found 0/
  );
});

test('unknown automatic input remains uncertain instead of defaulting to MET', () => {
  const prepared = prepareReviewInputs(
    'R1: Return a useful value.\nR2: Document it.\n',
    [
      'diff --git a/src/value.js b/src/value.js',
      '--- a/src/value.js',
      '+++ b/src/value.js',
      '@@ -1 +1 @@',
      '-return null;',
      '+return 1;',
      ''
    ].join('\n')
  );

  assert.equal(inferFixture(prepared), 'auto');
  const result = buildOfflineResult('auto', prepared);
  assert.equal(result.verdict, 'needs_information');
  assert.ok(result.coverage.every((item) => item.status === 'uncertain'));
  assert.ok(result.coverage.every((item) => item.evidence.every((evidence) => evidence.source === 'spec')));
  assert.deepEqual(validateEvidenceGrounding(result, prepared), { valid: true, errors: [] });
});

test('all canonical offline fixtures have explicit, evidence-valid status maps', () => {
  const expected = {
    compliant: { R1: 'met', R2: 'met', R3: 'met', R4: 'met', R5: 'met' },
    'missing-behavior': { R1: 'met', R2: 'met', R3: 'missing', R4: 'missing', R5: 'missing' },
    'missing-tests': { R1: 'met', R2: 'met', R3: 'missing', R4: 'missing' },
    security: { R1: 'met', R2: 'missing', R3: 'partial', R4: 'missing' },
    ambiguous: { R1: 'uncertain', R2: 'uncertain' },
    'prompt-injection': {
      R1: 'uncertain', R2: 'uncertain', R3: 'uncertain', R4: 'uncertain',
      R5: 'uncertain', R6: 'uncertain', REPEAT: 'uncertain', R7: 'uncertain',
      R8: 'uncertain', R9: 'uncertain', R10: 'uncertain', R11: 'uncertain',
      R12: 'uncertain', R13: 'uncertain'
    }
  };

  for (const [identity, expectedStatuses] of Object.entries(expected)) {
    const { prepared } = loadFixture(identity);
    const result = buildOfflineResult(identity, prepared);
    assert.deepEqual(statusMap(result), expectedStatuses, identity);
    assert.deepEqual(validateEvidenceGrounding(result, prepared), { valid: true, errors: [] }, identity);
  }
});

test('repeated missing-behavior reviews produce identical validated JSON and Markdown', async () => {
  const fixture = loadFixture('missing-behavior');
  async function run() {
    return reviewArtifacts({
      specification: fixture.specification,
      diff: fixture.diff,
      provider: createOfflineProvider({ fixture: 'missing-behavior' }),
      mode: 'offline',
      model: 'hy3-offline-fake',
      baseUrl: 'https://local.fake/v1',
      stream: true
    });
  }

  const first = await run();
  const second = await run();
  assert.equal(first.json, second.json);
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(first.provenance.validation, { schema: 'passed', evidence: 'passed' });
});
