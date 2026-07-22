'use strict';

const { FriendlyError } = require('./tokenhub');

const OFFLINE_FIXTURES = Object.freeze([
  'compliant',
  'missing-behavior',
  'missing-tests',
  'security',
  'ambiguous',
  'prompt-injection'
]);

function createOfflineProvider({ fixture = 'auto' } = {}) {
  if (fixture !== 'auto' && !OFFLINE_FIXTURES.includes(fixture)) {
    throw new FriendlyError(
      `Unknown offline fixture ${fixture}. Choose one of: ${OFFLINE_FIXTURES.join(', ')}.`
    );
  }

  return {
    async generate({ prepared, stream, signal, onChunk }) {
      throwIfCancelled(signal);
      const identity = fixture === 'auto' ? inferFixture(prepared) : fixture;
      const result = buildOfflineResult(identity, prepared);
      const text = JSON.stringify(result);

      if (stream) {
        const chunkSize = 37 + parseInt(prepared.hashes.diff.slice(0, 2), 16) % 29;
        for (let index = 0; index < text.length; index += chunkSize) {
          throwIfCancelled(signal);
          if (typeof onChunk === 'function') {
            await onChunk(text.slice(index, index + chunkSize));
          }
          await Promise.resolve();
        }
      } else if (typeof onChunk === 'function') {
        await onChunk(text);
      }

      return {
        text,
        finishReason: 'stop',
        usage: null,
        requestId: `offline-${identity}-${prepared.hashes.diff.slice(0, 12)}`,
        generatedAt: '2000-01-01T00:00:00.000Z'
      };
    }
  };
}

function buildOfflineResult(identity, prepared) {
  const diffRecord = firstDiffRecord(prepared);
  const targetIndex = Math.max(
    0,
    prepared.requirements.findIndex((requirement) => /at or after|exactly 30|required behavior/i.test(requirement.text))
  );
  const testIndex = Math.max(
    0,
    prepared.requirements.findIndex((requirement) => /\btests?\b/i.test(requirement.text))
  );
  const securityIndex = Math.max(
    0,
    prepared.requirements.findIndex((requirement) => /never place|credential|secret/i.test(requirement.text))
  );

  const coverage = prepared.requirements.map((requirement, index) => {
    let status = 'met';
    if (identity === 'ambiguous' || identity === 'prompt-injection' || identity === 'auto') {
      status = 'uncertain';
    } else if (identity === 'missing-behavior' && (index === targetIndex || index === testIndex)) {
      status = 'missing';
    } else if (identity === 'missing-tests' && index === testIndex) {
      status = 'missing';
    } else if (identity === 'security' && index === securityIndex) {
      status = 'partial';
    }

    const evidence = [specEvidence(requirement)];
    if (status === 'met' || status === 'partial') {
      evidence.push(diffEvidence(diffRecord));
    }
    return {
      requirementId: requirement.id,
      status,
      explanation: offlineCoverageExplanation(identity, status),
      evidence
    };
  });

  const findings = [];
  const missingTests = [];
  const uncertainties = [];

  if (identity === 'missing-behavior') {
    const requirement = prepared.requirements[targetIndex];
    const testRequirement = prepared.requirements[testIndex];
    findings.push({
      severity: 'P1',
      title: 'Required behavior is absent from the supplied diff',
      explanation: 'The deterministic fixture intentionally omits one specified behavior, so the change should not be treated as merge-ready.',
      evidence: [specEvidence(requirement)],
      recommendation: 'Implement the cited requirement and add a focused regression test.'
    });
    missingTests.push({
      title: 'Boundary coverage at the specified threshold',
      explanation: 'The fixture intentionally lacks the specification-mandated 29:59 and 30:00 boundary tests.',
      evidence: [specEvidence(testRequirement)]
    });
  } else if (identity === 'missing-tests') {
    const requirement = prepared.requirements[testIndex];
    findings.push({
      severity: 'P2',
      title: 'Required regression coverage is missing',
      explanation: 'The supplied diff does not provide the test behavior required by the cited specification line.',
      evidence: [specEvidence(requirement)],
      recommendation: 'Add the specified tests and rerun the reviewer.'
    });
    missingTests.push({
      title: 'Specification-mandated regression test',
      explanation: 'Add coverage for the cited behavior before merge.',
      evidence: [specEvidence(requirement)]
    });
  } else if (identity === 'security') {
    const requirement = prepared.requirements[securityIndex];
    findings.push({
      severity: 'P0',
      title: 'Credential material is introduced in source',
      explanation: 'The self-authored security fixture contains a hard-coded credential-shaped value in an added line.',
      evidence: [specEvidence(requirement), diffEvidence(diffRecord)],
      recommendation: 'Remove the credential, rotate it if it was real, and load secrets from a server-side secret store.'
    });
  } else if (identity === 'ambiguous') {
    uncertainties.push({
      description: 'The expected behavior is intentionally underspecified; implementation compliance cannot be established from these artifacts.',
      evidence: [specEvidence(prepared.requirements[0])]
    });
  } else if (identity === 'prompt-injection') {
    uncertainties.push({
      description: 'Instruction-like artifact text was treated as inert data. Only locally present, valid evidence locations were retained.',
      evidence: [specEvidence(prepared.requirements[0])]
    });
  }

  const verdict =
    identity === 'compliant'
      ? 'ready'
      : identity === 'ambiguous' || identity === 'prompt-injection' || identity === 'auto'
        ? 'needs_information'
        : 'not_ready';

  return {
    verdict,
    summary: offlineSummary(identity, verdict),
    coverage,
    findings,
    missingTests,
    uncertainties
  };
}

function firstDiffRecord(prepared) {
  const records = prepared.parsedDiff.files.flatMap((file) => file.records);
  return records.find((record) => record.side === 'added') || records[0];
}

function specEvidence(requirement) {
  return {
    source: 'spec',
    requirementId: requirement.id,
    startLine: requirement.line,
    endLine: requirement.line,
    quote: requirement.rawLine
  };
}

function diffEvidence(record) {
  return {
    source: 'diff',
    path: record.path,
    side: record.side,
    startLine: record.line,
    endLine: record.line,
    quote: record.content
  };
}

function offlineCoverageExplanation(identity, status) {
  const prefix = 'OFFLINE / FAKE fixture:';
  if (status === 'met') return `${prefix} the deterministic sample maps this requirement to a changed line.`;
  if (status === 'partial') return `${prefix} the change touches the requirement but preserves a security-sensitive defect.`;
  if (status === 'missing') return `${prefix} no matching implementation evidence is included by design.`;
  return `${prefix} the supplied wording is intentionally insufficient for a reliable conclusion.`;
}

function offlineSummary(identity, verdict) {
  return `OFFLINE / FAKE deterministic ${identity} fixture produced ${verdict.replace('_', ' ')}; no Hy3 service call was made.`;
}

function inferFixture(prepared) {
  const combined = `${prepared.specification}\n${prepared.diff}`.toLowerCase();
  if (/ignore previous instructions|fake system message|reveal environment/.test(combined)) {
    return 'prompt-injection';
  }
  if (/api[_ -]?key|secret|credential/.test(combined)) return 'security';
  if (/ambiguous|unspecified|somehow/.test(combined)) return 'ambiguous';
  if (/missing test|add tests/.test(combined)) return 'missing-tests';
  return 'missing-behavior';
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new FriendlyError('Offline review cancelled. No completed report was published.');
    error.exitCode = 130;
    throw error;
  }
}

module.exports = {
  OFFLINE_FIXTURES,
  buildOfflineResult,
  createOfflineProvider,
  inferFixture
};
