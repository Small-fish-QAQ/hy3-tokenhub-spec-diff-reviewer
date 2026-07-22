'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReviewValidationError,
  parseStructuredReview,
  validateStructuredReview
} = require('../lib/review_contract');

function validReview() {
  return {
    verdict: 'not_ready',
    summary: 'One required behavior is missing.',
    coverage: [
      {
        requirementId: 'R1',
        status: 'missing',
        explanation: 'No matching implementation evidence was found.',
        evidence: [
          { source: 'spec', requirementId: 'R1', startLine: 1, endLine: 1, quote: 'R1: Do the thing.' }
        ]
      }
    ],
    findings: [
      {
        severity: 'P1',
        title: 'Required behavior missing',
        explanation: 'The supplied diff does not implement R1.',
        evidence: [
          { source: 'spec', requirementId: 'R1', startLine: 1, endLine: 1, quote: 'R1: Do the thing.' }
        ],
        recommendation: 'Implement R1.'
      }
    ],
    missingTests: [
      {
        title: 'R1 regression test',
        explanation: 'Test the required behavior.',
        evidence: [
          { source: 'spec', requirementId: 'R1', startLine: 1, endLine: 1, quote: 'R1: Do the thing.' }
        ]
      }
    ],
    uncertainties: []
  };
}

test('structured review validator accepts the authoritative contract', () => {
  const value = validReview();
  assert.deepEqual(validateStructuredReview(value), { valid: true, errors: [] });
  assert.deepEqual(parseStructuredReview(JSON.stringify(value)), value);
});

test('malformed JSON and Markdown-fenced JSON fail instead of becoming reviews', () => {
  for (const text of ['{bad', '```json\n{}\n```', '', 'null']) {
    assert.throws(() => parseStructuredReview(text), ReviewValidationError);
  }
});

test('missing required fields fail with a precise JSON path', () => {
  for (const field of ['verdict', 'summary', 'coverage', 'findings', 'missingTests', 'uncertainties']) {
    const value = validReview();
    delete value[field];
    const validation = validateStructuredReview(value);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.path === `$.${field}`));
  }
});

test('unknown verdict, coverage status, severity, evidence source, and diff side fail', () => {
  const mutations = [
    (value) => { value.verdict = 'ready_after_fixes'; },
    (value) => { value.coverage[0].status = 'mostly_met'; },
    (value) => { value.findings[0].severity = 'critical'; },
    (value) => { value.coverage[0].evidence[0].source = 'repository'; },
    (value) => {
      value.findings[0].evidence[0] = {
        source: 'diff', path: 'x.js', side: 'new', startLine: 1, endLine: 1, quote: 'x'
      };
    }
  ];
  for (const mutate of mutations) {
    const value = validReview();
    mutate(value);
    assert.equal(validateStructuredReview(value).valid, false);
  }
});

test('empty finding content and evidence do not masquerade as a valid finding', () => {
  const emptyTitle = validReview();
  emptyTitle.findings[0].title = '   ';
  assert.equal(validateStructuredReview(emptyTitle).valid, false);

  const emptyEvidence = validReview();
  emptyEvidence.findings[0].evidence = [];
  assert.equal(validateStructuredReview(emptyEvidence).valid, false);
});

test('unexpected fields and duplicate coverage IDs fail closed', () => {
  const extra = validReview();
  extra.debug = 'not allowed';
  assert.equal(validateStructuredReview(extra).valid, false);

  const duplicate = validReview();
  duplicate.coverage.push(structuredClone(duplicate.coverage[0]));
  assert.ok(validateStructuredReview(duplicate).errors.some((error) => /unique/.test(error.message)));
});
