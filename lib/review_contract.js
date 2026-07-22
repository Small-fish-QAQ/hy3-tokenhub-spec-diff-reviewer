'use strict';

const { FriendlyError } = require('./tokenhub');

const VERDICTS = new Set(['ready', 'not_ready', 'needs_information']);
const COVERAGE_STATUSES = new Set(['met', 'partial', 'missing', 'uncertain']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const EVIDENCE_SOURCES = new Set(['spec', 'diff']);
const DIFF_SIDES = new Set(['added', 'deleted', 'context']);
const RESULT_SCHEMA_VERSION = '1.0';

class ReviewValidationError extends FriendlyError {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ReviewValidationError';
    this.errors = errors;
  }
}

function parseStructuredReview(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ReviewValidationError('Hy3 returned an empty structured result.', [
      { path: '$', message: 'must be a non-empty JSON document' }
    ]);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw new ReviewValidationError('Hy3 returned malformed JSON.', [
      { path: '$', message: 'must be valid JSON with no Markdown fence or trailing text' }
    ]);
  }

  const validation = validateStructuredReview(value);
  if (!validation.valid) {
    throw new ReviewValidationError(
      `Hy3 returned JSON that does not match the review contract (${validation.errors.length} validation error${validation.errors.length === 1 ? '' : 's'}).`,
      validation.errors
    );
  }

  return value;
}

function validateStructuredReview(value) {
  const errors = [];
  validateObject(value, '$', ['verdict', 'summary', 'coverage', 'findings', 'missingTests', 'uncertainties'], errors);
  if (!isPlainObject(value)) {
    return { valid: false, errors };
  }

  validateEnum(value.verdict, '$.verdict', VERDICTS, errors);
  validateNonEmptyString(value.summary, '$.summary', errors);
  validateArray(value.coverage, '$.coverage', errors, { minItems: 1 });
  validateArray(value.findings, '$.findings', errors);
  validateArray(value.missingTests, '$.missingTests', errors);
  validateArray(value.uncertainties, '$.uncertainties', errors);

  if (Array.isArray(value.coverage)) {
    const ids = new Set();
    value.coverage.forEach((item, index) => {
      const itemPath = `$.coverage[${index}]`;
      validateObject(item, itemPath, ['requirementId', 'status', 'explanation', 'evidence'], errors);
      if (!isPlainObject(item)) return;
      validateNonEmptyString(item.requirementId, `${itemPath}.requirementId`, errors);
      if (typeof item.requirementId === 'string' && item.requirementId.trim()) {
        if (ids.has(item.requirementId)) {
          errors.push({ path: `${itemPath}.requirementId`, message: 'must be unique' });
        }
        ids.add(item.requirementId);
      }
      validateEnum(item.status, `${itemPath}.status`, COVERAGE_STATUSES, errors);
      validateNonEmptyString(item.explanation, `${itemPath}.explanation`, errors);
      validateEvidenceArray(item.evidence, `${itemPath}.evidence`, errors);
    });
  }

  if (Array.isArray(value.findings)) {
    value.findings.forEach((item, index) => {
      const itemPath = `$.findings[${index}]`;
      validateObject(item, itemPath, ['severity', 'title', 'explanation', 'evidence', 'recommendation'], errors);
      if (!isPlainObject(item)) return;
      validateEnum(item.severity, `${itemPath}.severity`, SEVERITIES, errors);
      validateNonEmptyString(item.title, `${itemPath}.title`, errors);
      validateNonEmptyString(item.explanation, `${itemPath}.explanation`, errors);
      validateEvidenceArray(item.evidence, `${itemPath}.evidence`, errors, { minItems: 1 });
      validateNonEmptyString(item.recommendation, `${itemPath}.recommendation`, errors);
    });
  }

  if (Array.isArray(value.missingTests)) {
    value.missingTests.forEach((item, index) => {
      const itemPath = `$.missingTests[${index}]`;
      validateObject(item, itemPath, ['title', 'explanation', 'evidence'], errors);
      if (!isPlainObject(item)) return;
      validateNonEmptyString(item.title, `${itemPath}.title`, errors);
      validateNonEmptyString(item.explanation, `${itemPath}.explanation`, errors);
      validateEvidenceArray(item.evidence, `${itemPath}.evidence`, errors, { minItems: 1 });
    });
  }

  if (Array.isArray(value.uncertainties)) {
    value.uncertainties.forEach((item, index) => {
      const itemPath = `$.uncertainties[${index}]`;
      validateObject(item, itemPath, ['description', 'evidence'], errors);
      if (!isPlainObject(item)) return;
      validateNonEmptyString(item.description, `${itemPath}.description`, errors);
      validateEvidenceArray(item.evidence, `${itemPath}.evidence`, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateEvidenceArray(value, path, errors, options = {}) {
  validateArray(value, path, errors, options);
  if (!Array.isArray(value)) return;

  value.forEach((evidence, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(evidence)) {
      errors.push({ path: itemPath, message: 'must be an object' });
      return;
    }

    validateEnum(evidence.source, `${itemPath}.source`, EVIDENCE_SOURCES, errors);
    if (evidence.source === 'spec') {
      validateObject(evidence, itemPath, ['source', 'requirementId', 'startLine', 'endLine', 'quote'], errors);
      validateNonEmptyString(evidence.requirementId, `${itemPath}.requirementId`, errors);
    } else if (evidence.source === 'diff') {
      validateObject(evidence, itemPath, ['source', 'path', 'side', 'startLine', 'endLine', 'quote'], errors);
      validateNonEmptyString(evidence.path, `${itemPath}.path`, errors);
      validateEnum(evidence.side, `${itemPath}.side`, DIFF_SIDES, errors);
    }

    validatePositiveInteger(evidence.startLine, `${itemPath}.startLine`, errors);
    validatePositiveInteger(evidence.endLine, `${itemPath}.endLine`, errors);
    if (
      Number.isInteger(evidence.startLine) &&
      Number.isInteger(evidence.endLine) &&
      evidence.endLine < evidence.startLine
    ) {
      errors.push({ path: `${itemPath}.endLine`, message: 'must be greater than or equal to startLine' });
    }
    validateNonEmptyString(evidence.quote, `${itemPath}.quote`, errors);
  });
}

function validateObject(value, path, requiredKeys, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }

  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
  }

  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}.${key}`, message: 'is not allowed by the review contract' });
    }
  }
}

function validateArray(value, path, errors, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length < minItems) {
    errors.push({ path, message: `must contain at least ${minItems} item${minItems === 1 ? '' : 's'}` });
  }
}

function validateNonEmptyString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push({ path, message: 'must be a non-empty string' });
  }
}

function validateEnum(value, path, allowedValues, errors) {
  if (!allowedValues.has(value)) {
    errors.push({ path, message: `must be one of: ${[...allowedValues].join(', ')}` });
  }
}

function validatePositiveInteger(value, path, errors) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push({ path, message: 'must be a positive integer' });
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatValidationErrors(errors, limit = 20) {
  return errors
    .slice(0, limit)
    .map((error) => `${error.path}: ${error.message}`)
    .join('\n');
}

module.exports = {
  COVERAGE_STATUSES,
  DIFF_SIDES,
  RESULT_SCHEMA_VERSION,
  ReviewValidationError,
  SEVERITIES,
  VERDICTS,
  formatValidationErrors,
  parseStructuredReview,
  validateStructuredReview
};
