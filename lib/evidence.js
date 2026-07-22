'use strict';

const { createHash } = require('node:crypto');

const { FriendlyError } = require('./tokenhub');

function normalizeArtifact(text) {
  if (typeof text !== 'string') {
    throw new FriendlyError('Review artifacts must be UTF-8 text.');
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lineCount(text) {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function extractRequirements(specification) {
  const lines = specification.split('\n');
  const candidates = [];

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^```/.test(trimmed) || trimmed.endsWith(':')) {
      return;
    }

    const explicit = trimmed.match(/^((?:REQ|R)[A-Za-z0-9_.-]*)\s*[:.)-]\s+(.+)$/i);
    const list = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    const requirementText = explicit?.[2] || list?.[1] || trimmed;
    candidates.push({
      explicitId: explicit?.[1]?.toUpperCase() || null,
      line: index + 1,
      rawLine,
      text: requirementText
    });
  });

  if (candidates.length === 0) {
    const fallbackIndex = lines.findIndex((line) => line.trim().length > 0);
    if (fallbackIndex !== -1) {
      candidates.push({
        explicitId: null,
        line: fallbackIndex + 1,
        rawLine: lines[fallbackIndex],
        text: lines[fallbackIndex].trim()
      });
    }
  }

  const used = new Set();
  let generatedIndex = 1;
  return candidates.map((candidate) => {
    let id = candidate.explicitId;
    if (!id || used.has(id)) {
      while (used.has(`R${generatedIndex}`)) generatedIndex += 1;
      id = `R${generatedIndex}`;
      generatedIndex += 1;
    }
    used.add(id);
    return { id, line: candidate.line, text: candidate.text, rawLine: candidate.rawLine };
  });
}

function parseUnifiedDiff(diff) {
  const lines = diff.split('\n');
  const files = new Map();
  let currentPath = null;
  let oldLine = null;
  let newLine = null;
  let inHunk = false;

  function ensureFile(filePath) {
    if (!files.has(filePath)) {
      files.set(filePath, { path: filePath, records: [] });
    }
    return files.get(filePath);
  }

  for (const rawLine of lines) {
    const gitHeader = rawLine.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
    if (gitHeader) {
      currentPath = decodeDiffPath(gitHeader[2]);
      ensureFile(currentPath);
      inHunk = false;
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      const candidate = parseHeaderPath(rawLine.slice(4));
      if (candidate && candidate !== '/dev/null') {
        currentPath = candidate;
        ensureFile(currentPath);
      }
      continue;
    }

    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunk) {
      if (!currentPath) {
        throw new FriendlyError('The unified diff contains a hunk before a file path.');
      }
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentPath || rawLine.startsWith('\\ No newline at end of file')) {
      continue;
    }

    const prefix = rawLine[0];
    const content = rawLine.slice(1);
    const file = ensureFile(currentPath);
    if (prefix === '+') {
      file.records.push({ path: currentPath, side: 'added', line: newLine, content });
      newLine += 1;
    } else if (prefix === '-') {
      file.records.push({ path: currentPath, side: 'deleted', line: oldLine, content });
      oldLine += 1;
    } else if (prefix === ' ') {
      file.records.push({
        path: currentPath,
        side: 'context',
        line: newLine,
        oldLine,
        content
      });
      oldLine += 1;
      newLine += 1;
    } else {
      inHunk = false;
    }
  }

  const parsedFiles = [...files.values()].filter((file) => file.records.length > 0);
  if (parsedFiles.length === 0) {
    throw new FriendlyError(
      'The diff is not a supported textual unified diff: no file hunks with changed or context lines were found.'
    );
  }

  return { files: parsedFiles, paths: parsedFiles.map((file) => file.path) };
}

function parseHeaderPath(value) {
  const withoutTimestamp = value.split('\t')[0].trim();
  if (withoutTimestamp === '/dev/null') return withoutTimestamp;
  const unquoted = decodeDiffPath(withoutTimestamp.replace(/^"|"$/g, ''));
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
}

function decodeDiffPath(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function prepareReviewInputs(specification, diff) {
  const normalizedSpecification = normalizeArtifact(specification);
  const normalizedDiff = normalizeArtifact(diff);
  const requirements = extractRequirements(normalizedSpecification);
  const parsedDiff = parseUnifiedDiff(normalizedDiff);

  return {
    specification: normalizedSpecification,
    diff: normalizedDiff,
    specificationLines: normalizedSpecification.split('\n'),
    requirements,
    parsedDiff,
    hashes: {
      specification: sha256(normalizedSpecification),
      diff: sha256(normalizedDiff)
    },
    counts: {
      specificationBytes: Buffer.byteLength(normalizedSpecification, 'utf8'),
      specificationLines: lineCount(normalizedSpecification),
      diffBytes: Buffer.byteLength(normalizedDiff, 'utf8'),
      diffLines: lineCount(normalizedDiff)
    }
  };
}

function validateEvidenceGrounding(result, prepared) {
  const errors = [];
  const requirements = new Map(prepared.requirements.map((requirement) => [requirement.id, requirement]));
  const coverageIds = new Set();

  for (let index = 0; index < result.coverage.length; index += 1) {
    const item = result.coverage[index];
    const itemPath = `$.coverage[${index}]`;
    coverageIds.add(item.requirementId);
    if (!requirements.has(item.requirementId)) {
      errors.push({ path: `${itemPath}.requirementId`, message: 'does not exist in the normalized specification' });
    }

    const itemErrors = validateEvidenceList(item.evidence, prepared, `${itemPath}.evidence`);
    errors.push(...itemErrors);
    const sources = new Set(item.evidence.map((evidence) => evidence.source));
    if (!sources.has('spec')) {
      errors.push({ path: `${itemPath}.evidence`, message: 'must cite the specification requirement' });
    }
    if ((item.status === 'met' || item.status === 'partial') && !sources.has('diff')) {
      errors.push({ path: `${itemPath}.evidence`, message: `${item.status} coverage must cite relevant diff evidence` });
    }
    for (const evidence of item.evidence) {
      if (evidence.source === 'spec' && evidence.requirementId !== item.requirementId) {
        errors.push({
          path: `${itemPath}.evidence`,
          message: `specification evidence must cite ${item.requirementId}, not ${evidence.requirementId}`
        });
      }
    }
  }

  for (const requirement of prepared.requirements) {
    if (!coverageIds.has(requirement.id)) {
      errors.push({ path: '$.coverage', message: `is missing normalized requirement ${requirement.id}` });
    }
  }

  result.findings.forEach((finding, index) => {
    errors.push(...validateEvidenceList(finding.evidence, prepared, `$.findings[${index}].evidence`));
  });
  result.missingTests.forEach((test, index) => {
    errors.push(...validateEvidenceList(test.evidence, prepared, `$.missingTests[${index}].evidence`));
  });
  result.uncertainties.forEach((uncertainty, index) => {
    errors.push(...validateEvidenceList(uncertainty.evidence, prepared, `$.uncertainties[${index}].evidence`));
  });

  if (
    result.verdict === 'ready' &&
    (result.coverage.some((item) => item.status !== 'met') ||
      result.findings.some((finding) => finding.severity === 'P0' || finding.severity === 'P1'))
  ) {
    errors.push({
      path: '$.verdict',
      message: 'ready requires all normalized requirements to be met and no P0/P1 findings'
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateEvidenceList(evidenceList, prepared, basePath) {
  const errors = [];
  evidenceList.forEach((evidence, index) => {
    const evidencePath = `${basePath}[${index}]`;
    if (evidence.source === 'spec') {
      validateSpecEvidence(evidence, prepared, evidencePath, errors);
    } else if (evidence.source === 'diff') {
      validateDiffEvidence(evidence, prepared, evidencePath, errors);
    }
  });
  return errors;
}

function validateSpecEvidence(evidence, prepared, path, errors) {
  const requirement = prepared.requirements.find((item) => item.id === evidence.requirementId);
  if (!requirement) {
    errors.push({ path: `${path}.requirementId`, message: 'does not exist in the normalized specification' });
    return;
  }

  if (evidence.startLine < 1 || evidence.endLine > prepared.specificationLines.length) {
    errors.push({ path, message: 'specification line range is outside the normalized input' });
    return;
  }

  if (requirement.line < evidence.startLine || requirement.line > evidence.endLine) {
    errors.push({ path, message: `line range does not include ${evidence.requirementId} at line ${requirement.line}` });
  }

  const inputText = prepared.specificationLines
    .slice(evidence.startLine - 1, evidence.endLine)
    .join('\n');
  if (!inputText.includes(normalizeArtifact(evidence.quote))) {
    errors.push({ path: `${path}.quote`, message: 'does not match the cited normalized specification lines' });
  }
}

function validateDiffEvidence(evidence, prepared, path, errors) {
  const file = prepared.parsedDiff.files.find((item) => item.path === evidence.path);
  if (!file) {
    errors.push({ path: `${path}.path`, message: 'is not present in the reviewed diff' });
    return;
  }

  const records = file.records.filter(
    (record) =>
      record.side === evidence.side &&
      record.line >= evidence.startLine &&
      record.line <= evidence.endLine
  );
  if (records.length === 0) {
    errors.push({ path, message: 'diff line range does not exist for the cited path and side' });
    return;
  }

  const expectedLines = evidence.endLine - evidence.startLine + 1;
  const observedLines = new Set(records.map((record) => record.line));
  if (observedLines.size !== expectedLines) {
    errors.push({ path, message: 'diff line range is not contiguous in the cited side' });
  }

  const inputText = records.map((record) => record.content).join('\n');
  if (!inputText.includes(normalizeArtifact(evidence.quote))) {
    errors.push({ path: `${path}.quote`, message: 'does not match the cited normalized diff lines' });
  }
}

function evidenceCatalog(prepared) {
  return {
    specification: {
      requirements: prepared.requirements.map((requirement) => ({
        id: requirement.id,
        line: requirement.line,
        text: requirement.text,
        rawLine: requirement.rawLine
      })),
      lines: prepared.specificationLines.map((text, index) => ({ line: index + 1, text }))
    },
    diff: prepared.parsedDiff.files.map((file) => ({
      path: file.path,
      lines: file.records.map(({ side, line, content }) => ({ side, line, content }))
    }))
  };
}

module.exports = {
  evidenceCatalog,
  extractRequirements,
  lineCount,
  normalizeArtifact,
  parseUnifiedDiff,
  prepareReviewInputs,
  sha256,
  validateEvidenceGrounding
};
