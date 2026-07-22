'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const { RESULT_SCHEMA_VERSION } = require('./review_contract');
const { FriendlyError, redactSecrets } = require('./tokenhub');

const VERDICT_LABELS = {
  ready: 'READY',
  not_ready: 'NOT READY',
  needs_information: 'NEEDS INFORMATION'
};

function renderMarkdown(result, provenance) {
  const lines = [
    '# Codex + Hy3 Spec Diff Review',
    ''
  ];

  if (provenance.mode === 'offline') {
    lines.push('> **OFFLINE / FAKE RESULT** — deterministic local provider; no Hy3 API call was made.', '');
  }

  lines.push(
    `## ${VERDICT_LABELS[result.verdict]}`,
    '',
    result.summary,
    '',
    '## Requirement Coverage',
    '',
    '| Requirement | Status | Explanation | Verified evidence |',
    '| --- | --- | --- | --- |'
  );

  for (const item of result.coverage) {
    lines.push(
      `| ${escapeTable(item.requirementId)} | ${escapeTable(item.status.toUpperCase())} | ${escapeTable(item.explanation)} | ${escapeTable(item.evidence.map(formatEvidence).join('; '))} |`
    );
  }

  lines.push('', '## Findings', '');
  for (const severity of ['P0', 'P1', 'P2', 'P3']) {
    lines.push(`### ${severity}`, '');
    const findings = result.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      lines.push('None identified.', '');
      continue;
    }
    for (const finding of findings) {
      lines.push(
        `#### ${finding.title}`,
        '',
        finding.explanation,
        '',
        `- Evidence: ${finding.evidence.map(formatEvidence).join('; ')}`,
        `- Recommendation: ${finding.recommendation}`,
        ''
      );
    }
  }

  lines.push('## Missing Tests', '');
  if (result.missingTests.length === 0) {
    lines.push('None identified.', '');
  } else {
    for (const missingTest of result.missingTests) {
      lines.push(
        `- **${missingTest.title}:** ${missingTest.explanation} (${missingTest.evidence.map(formatEvidence).join('; ')})`
      );
    }
    lines.push('');
  }

  lines.push('## Uncertainties', '');
  if (result.uncertainties.length === 0) {
    lines.push('None identified.', '');
  } else {
    for (const uncertainty of result.uncertainties) {
      const suffix = uncertainty.evidence.length
        ? ` (${uncertainty.evidence.map(formatEvidence).join('; ')})`
        : '';
      lines.push(`- ${uncertainty.description}${suffix}`);
    }
    lines.push('');
  }

  lines.push(
    '## Provenance',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Tool | ${escapeTable(`${provenance.tool.name} ${provenance.tool.version}`)} |`,
    `| Mode | ${escapeTable(provenance.mode === 'offline' ? 'OFFLINE / FAKE' : 'live')} |`,
    `| Model | ${escapeTable(provenance.model)} |`,
    `| Provider | ${escapeTable(provenance.providerHost)} |`,
    `| Streaming | ${provenance.streaming ? 'yes' : 'no'} |`,
    `| Generated | ${escapeTable(provenance.generatedAt)} |`,
    `| Specification SHA-256 | \`${provenance.inputs.specification.sha256}\` |`,
    `| Diff SHA-256 | \`${provenance.inputs.diff.sha256}\` |`,
    `| Specification size | ${provenance.inputs.specification.bytes} bytes / ${provenance.inputs.specification.lines} lines |`,
    `| Diff size | ${provenance.inputs.diff.bytes} bytes / ${provenance.inputs.diff.lines} lines |`,
    `| Finish reason | ${escapeTable(provenance.provider.finishReason)} |`,
    `| Request ID | ${escapeTable(provenance.provider.requestId || 'not provided')} |`,
    `| Local schema validation | ${escapeTable(provenance.validation.schema)} |`,
    `| Local evidence validation | ${escapeTable(provenance.validation.evidence)} |`,
    `| Output format | ${escapeTable(provenance.outputFormatVersion)} |`,
    '',
    '## Limitations',
    '',
    'This report is advisory. Local checks prove the output shape and citation locations, not semantic correctness. Prompt-injection risk is reduced through data separation and validation, not eliminated.',
    ''
  );

  return lines.join('\n');
}

function renderJson(result, provenance) {
  return `${JSON.stringify({
    formatVersion: RESULT_SCHEMA_VERSION,
    result,
    provenance
  }, null, 2)}\n`;
}

function formatEvidence(evidence) {
  const quote = compactQuote(evidence.quote);
  if (evidence.source === 'spec') {
    return `spec ${evidence.requirementId} L${evidence.startLine}-L${evidence.endLine} “${quote}”`;
  }
  return `diff ${evidence.path} ${evidence.side} L${evidence.startLine}-L${evidence.endLine} “${quote}”`;
}

function compactQuote(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function deriveJsonOutputPath(markdownPath) {
  const extension = path.extname(markdownPath);
  if (extension.toLowerCase() === '.md') {
    return `${markdownPath.slice(0, -extension.length)}.json`;
  }
  return `${markdownPath}.json`;
}

async function publishReviewOutputs(outputPath, markdown, json, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const pathImpl = dependencies.pathImpl || path;
  const suffix = dependencies.suffix || `${process.pid}-${randomUUID()}`;
  const markdownPath = pathImpl.resolve(outputPath);
  const jsonPath = pathImpl.resolve(deriveJsonOutputPath(outputPath));
  const entries = [
    { finalPath: markdownPath, content: markdown },
    { finalPath: jsonPath, content: json }
  ];
  const published = [];

  try {
    for (const entry of entries) {
      await fsImpl.mkdir(pathImpl.dirname(entry.finalPath), { recursive: true });
      entry.temporaryPath = pathImpl.join(
        pathImpl.dirname(entry.finalPath),
        `.${pathImpl.basename(entry.finalPath)}.${suffix}.tmp`
      );
      entry.backupPath = `${entry.temporaryPath}.previous`;
      const handle = await fsImpl.open(entry.temporaryPath, 'wx');
      try {
        await handle.writeFile(entry.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    for (const entry of entries) {
      try {
        await fsImpl.rename(entry.finalPath, entry.backupPath);
        entry.hadPrevious = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    for (const entry of entries) {
      await fsImpl.rename(entry.temporaryPath, entry.finalPath);
      published.push(entry);
    }

    await Promise.all(entries.map((entry) => fsImpl.rm(entry.backupPath, { force: true })));
    return { markdownPath, jsonPath };
  } catch (error) {
    for (const entry of published.reverse()) {
      await fsImpl.rm(entry.finalPath, { force: true }).catch(() => {});
    }
    for (const entry of entries) {
      await fsImpl.rm(entry.temporaryPath, { force: true }).catch(() => {});
      if (entry.hadPrevious) {
        await fsImpl.rename(entry.backupPath, entry.finalPath).catch(() => {});
      } else {
        await fsImpl.rm(entry.backupPath, { force: true }).catch(() => {});
      }
    }
    throw new FriendlyError(`Unable to publish the review output bundle: ${redactSecrets(error?.message || String(error))}`);
  }
}

module.exports = {
  VERDICT_LABELS,
  deriveJsonOutputPath,
  formatEvidence,
  publishReviewOutputs,
  renderJson,
  renderMarkdown
};
