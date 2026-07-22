'use strict';

const {
  FriendlyError,
  MODEL,
  DEFAULT_BASE_URL,
  ProviderError,
  redactSecrets,
  requestModelList,
  resolveProviderConfig
} = require('./tokenhub');
const { sanitizeProviderHost } = require('./review_engine');

async function checkProvider({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = MODEL,
  timeoutMs = 15_000,
  signal,
  requestImpl = requestModelList
} = {}) {
  const config = resolveProviderConfig({ baseUrl, model });
  try {
    const result = await requestImpl({
      apiKey,
      baseUrl: config.baseUrl,
      timeoutMs,
      signal
    });

    const selected = result.models.find(
      (candidate) => candidate.id === config.model || candidate.name === config.model
    );
    if (!selected) {
      throw new ProviderError(
        `Configured model ${config.model} was not returned by the TokenHub model list.`,
        { code: 'MODEL_UNAVAILABLE' }
      );
    }
    if (selected.status && selected.status.toLowerCase() !== 'online') {
      throw new ProviderError(
        `Configured model ${config.model} is present but has status ${selected.status}.`,
        { code: 'MODEL_UNAVAILABLE' }
      );
    }

    return {
      ok: true,
      model: config.model,
      providerHost: sanitizeProviderHost(config.baseUrl),
      requestId: safeRequestId(result.requestId),
      modelStatus: selected.status || 'listed (status not provided)',
      operation: 'GET /v1/models (no specification or diff sent)'
    };
  } catch (error) {
    throw preflightError(error, { model: config.model, host: sanitizeProviderHost(config.baseUrl) }, apiKey);
  }
}

function preflightError(error, { model, host } = {}, apiKey) {
  const code = classifyPreflightCode(error);
  const labels = {
    AUTHENTICATION_FAILED: 'Authentication failed',
    MODEL_UNAVAILABLE: 'Model unavailable',
    REGION_MISMATCH: 'Provider region mismatch',
    ENDPOINT_UNAVAILABLE: 'Provider endpoint unavailable',
    TIMEOUT: 'Provider preflight timed out',
    MALFORMED_REQUEST: 'Provider rejected the preflight request',
    MALFORMED_RESPONSE: 'Provider returned a malformed preflight response',
    RATE_LIMITED: 'Provider rate limit prevented preflight',
    ACCESS_DENIED: 'Provider access policy denied preflight',
    CANCELLED: 'Provider preflight was cancelled',
    NETWORK_FAILURE: 'Provider network check failed'
  };
  const label = labels[code] || labels.NETWORK_FAILURE;
  const safeDetail = redactSecrets(error?.message || String(error), apiKey);
  const context = [host ? `host=${host}` : null, model ? `model=${model}` : null]
    .filter(Boolean)
    .join(', ');
  const regionHint = code === 'AUTHENTICATION_FAILED'
    ? ' TokenHub keys are region-scoped; verify that HY3_BASE_URL matches the region where the key was created.'
    : '';
  const friendly = new FriendlyError(`${label}${context ? ` (${context})` : ''}: ${safeDetail}${regionHint}`);
  friendly.code = code;
  return friendly;
}

function classifyPreflightCode(error) {
  if (error?.code === 'AUTHENTICATION_FAILED') return 'AUTHENTICATION_FAILED';
  if (error?.code === 'MODEL_UNAVAILABLE') return 'MODEL_UNAVAILABLE';
  if (error?.code === 'REGION_MISMATCH') return 'REGION_MISMATCH';
  if (error?.code === 'ENDPOINT_UNAVAILABLE') return 'ENDPOINT_UNAVAILABLE';
  if (error?.code === 'MALFORMED_REQUEST') return 'MALFORMED_REQUEST';
  if (error?.code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (error?.code === 'ACCESS_DENIED') return 'ACCESS_DENIED';
  if (error?.code === 'CANCELLED') return 'CANCELLED';
  if (error?.code === 'TEMPORARY_NETWORK_FAILURE') return 'ENDPOINT_UNAVAILABLE';
  if (error?.code === 'PROVIDER_TIMEOUT') return 'TIMEOUT';
  if (error?.code === 'MALFORMED_RESPONSE') return 'MALFORMED_RESPONSE';
  const message = String(error?.message || error).toLowerCase();
  if (/timed out|timeout/.test(message)) return 'TIMEOUT';
  if (/valid json|json object|no message content|malformed|finish reason/.test(message)) {
    return 'MALFORMED_RESPONSE';
  }
  return 'NETWORK_FAILURE';
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

module.exports = {
  checkProvider,
  classifyPreflightCode,
  preflightError
};
