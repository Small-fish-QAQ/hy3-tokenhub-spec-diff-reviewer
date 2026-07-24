'use strict';

const elements = {
  mode: document.getElementById('mode'),
  modeBadge: document.getElementById('mode-badge'),
  modelBadge: document.getElementById('model-badge'),
  validationBadge: document.getElementById('validation-badge'),
  privacyNote: document.getElementById('privacy-note'),
  loadSample: document.getElementById('load-sample'),
  start: document.getElementById('start-review'),
  cancel: document.getElementById('cancel-review'),
  offlineBanner: document.getElementById('offline-banner'),
  stagedBanner: document.getElementById('staged-banner'),
  stagedSummary: document.getElementById('staged-summary'),
  stagedEdited: document.getElementById('staged-edited'),
  specification: document.getElementById('specification'),
  diff: document.getElementById('diff'),
  specCount: document.getElementById('spec-count'),
  diffCount: document.getElementById('diff-count'),
  resultPanel: document.getElementById('result-panel'),
  resultTitle: document.getElementById('result-title'),
  runStatus: document.getElementById('run-status'),
  errorBox: document.getElementById('error-box'),
  progressList: document.getElementById('progress-list'),
  emptyResult: document.getElementById('empty-result'),
  reviewOutput: document.getElementById('review-output'),
  verdictCard: document.getElementById('verdict-card'),
  verdictHeading: document.getElementById('verdict-heading'),
  verdictSummary: document.getElementById('verdict-summary'),
  coverageSummary: document.getElementById('coverage-summary'),
  coverageBody: document.getElementById('coverage-body'),
  findingsSummary: document.getElementById('findings-summary'),
  findingsList: document.getElementById('findings-list'),
  missingTests: document.getElementById('missing-tests'),
  uncertainties: document.getElementById('uncertainties'),
  localValidation: document.getElementById('local-validation'),
  provenanceGrid: document.getElementById('provenance-grid'),
  downloadActions: document.getElementById('download-actions'),
  downloadMarkdown: document.getElementById('download-markdown'),
  downloadJson: document.getElementById('download-json')
};

const VERDICT_LABELS = Object.freeze({
  ready: 'READY',
  not_ready: 'NOT READY',
  needs_information: 'NEEDS INFORMATION'
});

let activeController = null;
let runSequence = 0;
let selectedFixture = 'auto';
let currentDownloads = null;
let sampleLoading = false;
let stagedSource = null;
let serverConfiguration = {
  defaultMode: 'offline',
  liveAvailable: false,
  model: 'hy3',
  providerHost: 'loading',
  stagedBootstrap: false
};

elements.mode.addEventListener('change', updateModePresentation);
elements.loadSample.addEventListener('click', loadSample);
elements.start.addEventListener('click', startReview);
elements.cancel.addEventListener('click', cancelReview);
elements.specification.addEventListener('input', handleArtifactEdit);
elements.diff.addEventListener('input', handleArtifactEdit);
elements.downloadMarkdown.addEventListener('click', () => {
  if (currentDownloads) downloadText(currentDownloads.markdown, 'codex-hy3-review.md', 'text/markdown');
});
elements.downloadJson.addEventListener('click', () => {
  if (currentDownloads) downloadText(currentDownloads.json, 'codex-hy3-review.json', 'application/json');
});

initialize();

async function initialize() {
  updateCounts();
  updateModePresentation();
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Configuration request failed.');
    serverConfiguration = await response.json();
    elements.modelBadge.textContent = `model: ${serverConfiguration.model}`;
    const liveOption = elements.mode.querySelector('option[value="live"]');
    if (liveOption && !serverConfiguration.liveAvailable) {
      liveOption.textContent = 'Live Hy3 (server key required)';
    }
    updateModePresentation();
  } catch (_error) {
    elements.modelBadge.textContent = 'model: unavailable';
    setStatus('The local server configuration could not be read. Offline inputs remain editable.', false);
    return;
  }
  if (serverConfiguration.stagedBootstrap) await loadStagedBootstrap();
}

async function loadStagedBootstrap() {
  sampleLoading = true;
  try {
    const response = await fetch('/api/bootstrap', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    if (!payload || !payload.staged) throw new Error('The staged payload was empty.');
    stagedSource = payload.staged;
    elements.specification.value = stagedSource.specification;
    elements.diff.value = stagedSource.diff;
    elements.specification.setSelectionRange(0, 0);
    elements.diff.setSelectionRange(0, 0);
    selectedFixture = 'auto';
    updateCounts();
    elements.mode.value = stagedSource.preferredMode === 'offline' ? 'offline' : 'live';
    updateModePresentation();
    renderStagedState();
    if (elements.mode.value === 'offline') {
      setStatus(`Staged Git change loaded from repository ${stagedSource.repository}. Inspect both inputs, then start the review.`, false);
    } else if (serverConfiguration.liveAvailable) {
      setStatus(`Staged Git change loaded from repository ${stagedSource.repository}. Inspect both inputs, then select Review with Hy3.`, false);
    } else {
      setError('Live / Hy3 needs a TokenHub credential in the local server environment. Configure the server and relaunch, or explicitly switch the mode to Offline / Fake.');
      setStatus('Staged Git change loaded. Live / Hy3 is not configured on the local server.', false);
    }
  } catch (_error) {
    showError('The staged bootstrap payload could not be loaded. Reload this page, or paste the specification and diff manually.');
  } finally {
    sampleLoading = false;
  }
}

function renderStagedState() {
  if (!stagedSource) return;
  const parts = [`repository ${stagedSource.repository}`];
  if (stagedSource.branch) parts.push(`branch ${stagedSource.branch}`);
  parts.push(`specification ${stagedSource.specPath}`);
  parts.push(`diff from \`${stagedSource.diffCommand}\``);
  elements.stagedSummary.textContent = parts.join(' · ');
  elements.stagedBanner.hidden = false;
  updateStagedIndicator();
}

function updateStagedIndicator() {
  if (!stagedSource) return;
  const pristine = elements.specification.value === stagedSource.specification
    && elements.diff.value === stagedSource.diff;
  elements.stagedEdited.hidden = pristine;
}

function handleArtifactEdit() {
  selectedFixture = 'auto';
  updateCounts();
  updateStagedIndicator();
}

function updateCounts() {
  elements.specCount.textContent = formatLineCount(elements.specification.value);
  elements.diffCount.textContent = formatLineCount(elements.diff.value);
}

function formatLineCount(value) {
  const count = value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
  return `${count} line${count === 1 ? '' : 's'}`;
}

function updateModePresentation() {
  const offline = elements.mode.value === 'offline';
  elements.offlineBanner.hidden = !offline;
  elements.modeBadge.textContent = offline ? 'OFFLINE / FAKE' : 'LIVE';
  elements.modeBadge.classList.toggle('badge-offline', offline);
  elements.modeBadge.classList.toggle('badge-live', !offline);
  elements.start.textContent = offline ? 'Start review' : 'Review with Hy3';

  if (offline) {
    elements.privacyNote.textContent = 'Only the text in these two editors is reviewed. Offline mode makes no provider request.';
  } else if (serverConfiguration.liveAvailable) {
    elements.privacyNote.textContent = `Live mode sends only these two artifacts to ${serverConfiguration.providerHost}; credentials remain on the local server.`;
  } else {
    elements.privacyNote.textContent = 'Live mode needs a TokenHub credential in the local server environment. No credential is accepted by this page.';
  }
}

async function loadSample() {
  if (activeController || sampleLoading) return;
  sampleLoading = true;
  elements.loadSample.disabled = true;
  elements.start.disabled = true;
  setError('');
  setStatus('Loading the bundled self-authored sample…', true);
  try {
    const response = await fetch('/api/sample', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw await responseError(response);
    const sample = await response.json();
    elements.specification.value = sample.specification;
    elements.diff.value = sample.diff;
    elements.specification.setSelectionRange(0, 0);
    elements.diff.setSelectionRange(0, 0);
    elements.specification.scrollTop = 0;
    elements.diff.scrollTop = 0;
    selectedFixture = sample.fixture || 'auto';
    updateCounts();
    updateStagedIndicator();
    setStatus(`Loaded sample: ${sample.name}.`, false);
    elements.specification.focus();
  } catch (error) {
    showError(error.message || 'Unable to load the bundled sample.');
  } finally {
    sampleLoading = false;
    elements.loadSample.disabled = false;
    elements.start.disabled = false;
  }
}

async function startReview() {
  if (activeController || sampleLoading) return;

  const runId = ++runSequence;
  const controller = new AbortController();
  activeController = controller;
  currentDownloads = null;
  clearResult();
  setBusy(true);
  setStatus('Starting review…', true);

  const requestBody = {
    specification: elements.specification.value,
    diff: elements.diff.value,
    mode: elements.mode.value,
    stream: true
  };
  if (elements.mode.value === 'offline') requestBody.fixture = selectedFixture;

  let sawResult = false;
  try {
    const response = await fetch('/api/review', {
      method: 'POST',
      headers: {
        Accept: 'application/x-ndjson',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (runId !== runSequence) return;
    if (!response.ok) throw await responseError(response);

    await readNdjson(response, (event) => {
      if (runId !== runSequence) return;
      if (event.type === 'result') sawResult = true;
      handleReviewEvent(event);
    });

    if (runId === runSequence && !sawResult) {
      throw new Error('The server response ended without a completed review.');
    }
  } catch (error) {
    if (runId !== runSequence) return;
    if (error.name === 'AbortError') {
      setStatus('Review cancelled. No completed browser result was retained.', false);
    } else {
      showError(error.message || 'The review failed safely.');
    }
  } finally {
    if (runId === runSequence) {
      activeController = null;
      setBusy(false);
    }
  }
}

function cancelReview() {
  if (!activeController) return;
  runSequence += 1;
  const controller = activeController;
  activeController = null;
  controller.abort();
  setBusy(false);
  clearResult();
  setStatus('Review cancelled. No completed browser result was retained.', false);
}

function handleReviewEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('The server emitted an invalid review event.');

  if (event.type === 'accepted') {
    elements.modelBadge.textContent = `model: ${event.model}`;
    setStatus(event.offline ? 'Offline / Fake review accepted.' : 'Live Hy3 review accepted.', true);
    return;
  }

  if (event.type === 'progress') {
    appendProgress(event.stage, event.label);
    setStatus(event.label, true);
    return;
  }

  if (event.type === 'provider_activity') {
    setStatus(`Receiving structured provider output… ${event.receivedCharacters} characters`, true);
    return;
  }

  if (event.type === 'error') {
    throw new Error(event.message || 'The review failed safely.');
  }

  if (event.type === 'result') {
    renderReview(event.review);
  }
}

async function readNdjson(response, onEvent) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('This browser does not support streamed review responses.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(parseEvent(line));
    }
    if (done) break;
  }

  if (buffer.trim()) onEvent(parseEvent(buffer.trim()));
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    throw new Error('The server emitted malformed streamed JSON.');
  }
}

function appendProgress(stage, label) {
  const last = elements.progressList.lastElementChild;
  if (last && last.dataset.stage === stage) return;
  const item = document.createElement('li');
  item.dataset.stage = stage || 'unknown';
  item.textContent = label || stage || 'Review stage';
  elements.progressList.append(item);
}

function renderReview(review) {
  if (!review || !review.result || !review.provenance) {
    throw new Error('The server did not return a complete validated review.');
  }

  const { result, provenance } = review;
  const verdictLabel = VERDICT_LABELS[result.verdict] || String(result.verdict).toUpperCase();
  elements.emptyResult.hidden = true;
  elements.reviewOutput.hidden = false;
  elements.downloadActions.hidden = false;
  elements.verdictHeading.textContent = verdictLabel;
  elements.verdictSummary.textContent = result.summary;
  elements.verdictCard.className = `verdict-card verdict-${result.verdict.replaceAll('_', '-')}`;

  renderCoverage(result.coverage);
  renderFindings(result.findings);
  renderMissingTests(result.missingTests);
  renderUncertainties(result.uncertainties);
  renderProvenance(provenance);

  currentDownloads = { markdown: review.markdown, json: review.json };
  elements.validationBadge.textContent = 'schema passed · evidence passed';
  elements.validationBadge.classList.add('badge-valid');
  elements.localValidation.textContent = `${provenance.validation.schema} schema · ${provenance.validation.evidence} evidence`;
  setStatus(`Review complete: ${verdictLabel}.`, false);
}

function renderCoverage(coverage) {
  elements.coverageBody.replaceChildren();
  const met = coverage.filter((item) => item.status === 'met').length;
  elements.coverageSummary.textContent = `${met}/${coverage.length} met`;

  for (const item of coverage) {
    const row = document.createElement('tr');
    row.append(
      cell(item.requirementId),
      statusCell(item.status),
      cell(item.explanation),
      evidenceCell(item.evidence)
    );
    elements.coverageBody.append(row);
  }
}

function renderFindings(findings) {
  elements.findingsList.replaceChildren();
  elements.findingsSummary.textContent = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  if (findings.length === 0) {
    elements.findingsList.append(emptyCopy('No locally validated findings were returned.'));
    return;
  }

  for (const finding of findings) {
    const card = document.createElement('article');
    card.className = 'finding-card';
    const header = document.createElement('div');
    header.className = 'finding-card-header';
    const severity = document.createElement('span');
    severity.className = `severity severity-${finding.severity.toLowerCase()}`;
    severity.textContent = finding.severity;
    const title = document.createElement('h4');
    title.textContent = finding.title;
    header.append(severity, title);

    const explanation = document.createElement('p');
    explanation.textContent = finding.explanation;
    const recommendation = document.createElement('p');
    recommendation.className = 'recommendation';
    recommendation.textContent = `Recommended: ${finding.recommendation}`;
    card.append(header, explanation, evidenceDetails(finding.evidence), recommendation);
    elements.findingsList.append(card);
  }
}

function renderMissingTests(items) {
  elements.missingTests.replaceChildren();
  if (items.length === 0) {
    elements.missingTests.append(emptyCopy('None identified.'));
    return;
  }
  const list = document.createElement('ul');
  list.className = 'result-list';
  for (const item of items) {
    const entry = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${item.title}: `;
    entry.append(title, document.createTextNode(item.explanation), evidenceDetails(item.evidence));
    list.append(entry);
  }
  elements.missingTests.append(list);
}

function renderUncertainties(items) {
  elements.uncertainties.replaceChildren();
  if (items.length === 0) {
    elements.uncertainties.append(emptyCopy('None identified.'));
    return;
  }
  const list = document.createElement('ul');
  list.className = 'result-list';
  for (const item of items) {
    const entry = document.createElement('li');
    entry.append(document.createTextNode(item.description));
    if (item.evidence.length) entry.append(evidenceDetails(item.evidence));
    list.append(entry);
  }
  elements.uncertainties.append(list);
}

function renderProvenance(provenance) {
  elements.provenanceGrid.replaceChildren();
  const fields = [
    ['Mode', provenance.mode === 'offline' ? 'OFFLINE / FAKE' : 'live'],
    ['Model', provenance.model],
    ['Provider', provenance.providerHost],
    ['Streaming', provenance.streaming ? 'yes' : 'no'],
    ['Generated', provenance.generatedAt],
    ['Spec SHA-256', provenance.inputs.specification.sha256, true],
    ['Diff SHA-256', provenance.inputs.diff.sha256, true],
    ['Spec size', `${provenance.inputs.specification.bytes} bytes · ${provenance.inputs.specification.lines} lines`],
    ['Diff size', `${provenance.inputs.diff.bytes} bytes · ${provenance.inputs.diff.lines} lines`],
    ['Finish reason', provenance.provider.finishReason],
    ['Provider request', provenance.provider.requestId || 'not provided'],
    ['Output format', provenance.outputFormatVersion]
  ];

  for (const [label, value, hash] of fields) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = String(value);
    if (hash) description.className = 'hash';
    wrapper.append(term, description);
    elements.provenanceGrid.append(wrapper);
  }

  const offline = provenance.mode === 'offline';
  elements.modeBadge.textContent = offline ? 'OFFLINE / FAKE' : 'LIVE';
  elements.modeBadge.classList.toggle('badge-offline', offline);
  elements.modeBadge.classList.toggle('badge-live', !offline);
  elements.offlineBanner.hidden = !offline;
}

function evidenceCell(evidence) {
  const td = document.createElement('td');
  td.append(evidenceDetails(evidence));
  return td;
}

function evidenceDetails(evidence) {
  const details = document.createElement('details');
  details.className = 'evidence';
  const summary = document.createElement('summary');
  summary.textContent = `${evidence.length} verified citation${evidence.length === 1 ? '' : 's'}`;
  const list = document.createElement('ul');
  list.className = 'evidence-list';

  for (const citation of evidence) {
    const item = document.createElement('li');
    item.className = 'evidence-item';
    const location = document.createElement('span');
    location.className = 'evidence-location';
    location.textContent = citation.source === 'spec'
      ? `spec ${citation.requirementId} · L${citation.startLine}–${citation.endLine}`
      : `diff ${citation.path} · ${citation.side} L${citation.startLine}–${citation.endLine}`;
    const quote = document.createElement('span');
    quote.className = 'evidence-quote';
    quote.textContent = `“${citation.quote}”`;
    item.append(location, quote);
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

function cell(value) {
  const td = document.createElement('td');
  td.textContent = value;
  return td;
}

function statusCell(status) {
  const td = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = `status-pill status-${status}`;
  pill.textContent = status;
  td.append(pill);
  return td;
}

function emptyCopy(value) {
  const paragraph = document.createElement('p');
  paragraph.className = 'empty-copy';
  paragraph.textContent = value;
  return paragraph;
}

function clearResult() {
  currentDownloads = null;
  elements.reviewOutput.hidden = true;
  elements.emptyResult.hidden = false;
  elements.downloadActions.hidden = true;
  elements.progressList.replaceChildren();
  elements.validationBadge.textContent = 'validation: pending';
  elements.validationBadge.classList.remove('badge-valid');
  setError('');
}

function setBusy(busy) {
  elements.resultPanel.setAttribute('aria-busy', String(busy));
  elements.start.disabled = busy;
  elements.cancel.disabled = !busy;
  elements.loadSample.disabled = busy;
  elements.mode.disabled = busy;
  elements.specification.disabled = busy;
  elements.diff.disabled = busy;
}

function setStatus(message, running) {
  elements.runStatus.textContent = message;
  elements.runStatus.classList.toggle('running', Boolean(running));
}

function setError(message) {
  elements.errorBox.textContent = message;
  elements.errorBox.hidden = !message;
}

function showError(message) {
  setStatus('Review did not complete.', false);
  setError(message);
}

async function responseError(response) {
  try {
    const payload = await response.json();
    return new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  } catch (_error) {
    return new Error(`Request failed with HTTP ${response.status}.`);
  }
}

function downloadText(content, filename, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
