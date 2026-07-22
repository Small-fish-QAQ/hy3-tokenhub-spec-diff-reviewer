#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  DEFAULT_BASE_URL,
  MODEL,
  FriendlyError,
  createTokenHubProvider,
  redactSecrets,
  requestChatCompletion,
  resolveProviderConfig
} = require('./lib/tokenhub');
const {
  loadDiffReviewInputs,
  parseDiffReviewArgs,
  validateOutputPath
} = require('./lib/diff_review');
const { createOfflineProvider, OFFLINE_FIXTURES } = require('./lib/offline_provider');
const { checkProvider } = require('./lib/preflight');
const { reviewArtifacts } = require('./lib/review_engine');
const { publishReviewOutputs } = require('./lib/render');

async function main(args = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const command = args[0];

  if (!command) {
    printUsage(stdout);
    return 1;
  }

  if (command === '--help' || command === '-h') {
    printUsage(stdout);
    return 0;
  }
  if (command === 'diff-review') {
    await runDiffReview(args.slice(1), dependencies);
    return 0;
  }
  if (command === 'check') {
    await runCheck(args.slice(1), dependencies);
    return 0;
  }
  if (command === 'serve') {
    await runServer(args.slice(1), dependencies);
    return 0;
  }

  throw new FriendlyError(`Invalid command: ${command}. Run with --help to see available commands.`);
}

async function runDiffReview(args, dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const options = parseDiffReviewArgs(args);

  if (options.help) {
    printDiffReviewHelp(stdout);
    return;
  }

  const validateOutput = dependencies.validateOutputPath || validateOutputPath;
  await validateOutput(options, dependencies.outputPathDependencies);

  progressLine(stderr, 'validating_inputs', 'Validating input paths', options.offline);
  progressLine(stderr, 'preparing_specification', `Specification: ${displayPath(options.spec)}`, options.offline);
  if (options.git) {
    progressLine(stderr, 'reading_diff', 'Diff source: staged Git index only', options.offline);
  } else if (options.diff === '-') {
    progressLine(stderr, 'reading_diff', 'Diff source: standard input', options.offline);
  } else {
    progressLine(stderr, 'reading_diff', `Diff source: ${displayPath(options.diff)}`, options.offline);
  }

  const loadInputs = dependencies.loadDiffReviewInputs || loadDiffReviewInputs;
  const { specification, diff } = await loadInputs(options, dependencies.inputDependencies);
  const providerSetup = configureProvider(options, dependencies, stderr);

  const execute = (signal) => reviewArtifacts({
    specification,
    diff,
    provider: providerSetup.provider,
    mode: providerSetup.mode,
    model: providerSetup.model,
    baseUrl: providerSetup.baseUrl,
    stream: options.stream,
    timeoutMs: options.timeoutSeconds * 1_000,
    signal,
    allowRepair: dependencies.allowRepair !== false,
    now: dependencies.now,
    onProviderChunk: dependencies.onProviderChunk,
    onProgress: (event) => {
      if (!['validating_inputs', 'preparing_specification', 'reading_diff'].includes(event.stage)) {
        progressLine(stderr, event.stage, event.label, options.offline);
      }
      dependencies.onProgress?.(event);
    }
  });

  const reviewed = dependencies.signal
    ? await execute(dependencies.signal)
    : await withInterruptSignal(execute);

  stdout.write(reviewed.markdown);
  if (!reviewed.markdown.endsWith('\n')) stdout.write('\n');

  if (options.output) {
    const publish = dependencies.publishReviewOutputs || publishReviewOutputs;
    const saved = await publish(options.output, reviewed.markdown, reviewed.json, dependencies.publishDependencies);
    stderr.write(`Saved Markdown: ${displayPath(saved.markdownPath)}\n`);
    stderr.write(`Saved JSON + provenance: ${displayPath(saved.jsonPath)}\n`);
  }

  return {
    ...reviewed,
    text: reviewed.markdown,
    finishReason: reviewed.provenance.provider.finishReason
  };
}

function configureProvider(options, dependencies, stderr) {
  if (options.offline) {
    return {
      provider: dependencies.provider || createOfflineProvider({ fixture: options.fixture }),
      mode: 'offline',
      model: 'hy3-offline-fake',
      baseUrl: 'https://local.fake/v1'
    };
  }

  const environment = loadEnvironment(dependencies.environment);
  const getApiKey = dependencies.loadApiKey || loadApiKey;
  const apiKey = getApiKey(environment);
  const config = resolveProviderConfig({
    baseUrl: environment.HY3_BASE_URL || DEFAULT_BASE_URL,
    model: environment.HY3_MODEL || MODEL
  });

  let provider = dependencies.provider;
  if (!provider) {
    const request = dependencies.requestChatCompletion || requestChatCompletion;
    provider = createTokenHubProvider({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: 0.1,
      maxTokens: 4_000,
      responseFormat: { type: 'json_object' },
      fetchImpl: dependencies.fetchImpl,
      sleepImpl: dependencies.sleepImpl,
      random: dependencies.random,
      onRetry: (event) => {
        stderr.write(`Provider retry ${event.attempt}/${event.maxRetries} in ${event.delayMs} ms (${event.code}).\n`);
        dependencies.onRetry?.(event);
      },
      requestChatCompletion: request
    });
    if (request !== requestChatCompletion) {
      provider = {
        generate: ({ messages, stream, timeoutMs, signal, onChunk }) => request({
          messages,
          stream,
          timeoutMs,
          signal,
          onText: onChunk,
          apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          temperature: 0.1,
          maxTokens: 4_000,
          responseFormat: { type: 'json_object' }
        })
      };
    }
  }

  return {
    provider,
    mode: 'live',
    model: config.model,
    baseUrl: config.baseUrl
  };
}

async function runCheck(args, dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const options = parseCheckArgs(args);
  if (options.help) {
    printCheckHelp(stdout);
    return;
  }

  const environment = loadEnvironment(dependencies.environment);
  const apiKey = (dependencies.loadApiKey || loadApiKey)(environment);
  const config = resolveProviderConfig({
    baseUrl: environment.HY3_BASE_URL || DEFAULT_BASE_URL,
    model: environment.HY3_MODEL || MODEL
  });
  const execute = (signal) => (dependencies.checkProvider || checkProvider)({
    apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: options.timeoutSeconds * 1_000,
    signal,
    requestImpl: dependencies.requestModelList
  });
  const result = dependencies.signal
    ? await execute(dependencies.signal)
    : await withInterruptSignal(execute);

  stdout.write('TokenHub preflight: OK\n');
  stdout.write(`Provider: ${result.providerHost}\n`);
  stdout.write(`Model: ${result.model} (${result.modelStatus})\n`);
  stdout.write(`Operation: ${result.operation}\n`);
  stdout.write(`Request ID: ${result.requestId || 'not provided'}\n`);
  return result;
}

async function runServer(args, dependencies = {}) {
  const { parseServerArgs, startServer } = require('./lib/server');
  const options = parseServerArgs(args);
  if (options.help) {
    (dependencies.stdout || process.stdout).write('Usage: node hy3_showcase.js serve [--port <0-65535>] [--host 127.0.0.1]\n');
    return;
  }
  const started = await startServer({ ...options, ...dependencies.serverDependencies });
  const stdout = dependencies.stdout || process.stdout;
  stdout.write(`Codex + Hy3 review console: ${started.url}\n`);
  stdout.write('Bound to loopback only. Press Ctrl+C to stop.\n');
  return started;
}

function parseCheckArgs(args) {
  const options = { timeoutSeconds: 15, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--timeout') {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120) {
        throw new FriendlyError('--timeout must be a whole number from 1 to 120 seconds.');
      }
      options.timeoutSeconds = Number(value);
      index += 1;
    } else {
      throw new FriendlyError(`Unknown check option: ${argument}`);
    }
  }
  return options;
}

async function withInterruptSignal(operation) {
  const controller = new AbortController();
  let interrupted = false;
  const handleInterrupt = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', handleInterrupt);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (interrupted) error.exitCode = 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
  }
}

async function callModel(options, dependencies = {}) {
  const request = dependencies.requestChatCompletion || requestChatCompletion;
  if (dependencies.signal) return request({ ...options, signal: dependencies.signal });
  return withInterruptSignal((signal) => request({ ...options, signal }));
}

function loadEnvironment(environment) {
  if (environment) return environment;
  require('dotenv').config({ quiet: true });
  return process.env;
}

function loadApiKey(environment) {
  const apiKey = normalizeApiKey(environment?.TOKENHUB_API_KEY);
  if (!isUsableApiKey(apiKey)) {
    throw new FriendlyError(
      'Missing TOKENHUB_API_KEY. Copy .env.example to .env, add your region-scoped TokenHub key, and run the command again.'
    );
  }
  return apiKey;
}

function isUsableApiKey(apiKey) {
  const normalized = normalizeApiKey(apiKey);
  return normalized.length > 0 && normalized !== 'your_tokenhub_api_key_here';
}

function normalizeApiKey(apiKey) {
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

function printUsage(output = process.stdout) {
  output.write('Hy3 TokenHub Spec-to-Diff Reviewer\n');
  output.write('Codex + Hy3 Evidence-Grounded Spec Diff Reviewer\n\n');
  output.write('Usage:\n');
  output.write('  node hy3_showcase.js diff-review --spec <path> (--diff <path> | --diff - | --git) [options]\n');
  output.write('  node hy3_showcase.js check [--timeout <seconds>]\n');
  output.write('  node hy3_showcase.js serve [--port <port>]\n\n');
  output.write('Commands:\n');
  output.write('  diff-review  Compare a written specification with a proposed diff\n');
  output.write('  check        Verify TokenHub endpoint, authentication, and model listing\n');
  output.write('  serve        Start the local browser review console\n\n');
  output.write('Canonical Codex workflow:\n');
  output.write('  npm run review:staged -- --spec examples/spec.md\n');
}

function printDiffReviewHelp(output = process.stdout) {
  output.write('Usage:\n');
  output.write('  node hy3_showcase.js diff-review --spec <path> (--diff <path> | --diff - | --git) [options]\n\n');
  output.write('Required:\n');
  output.write('  --spec <path>       Written specification\n');
  output.write('  --diff <path>       Unified diff file\n');
  output.write('  --diff -            Read unified diff from standard input\n');
  output.write('  --git               Read only `git diff --cached` (choose one diff source)\n\n');
  output.write('Options:\n');
  output.write('  --output <path>     Atomically publish Markdown plus a JSON/provenance sidecar\n');
  output.write('  --timeout <seconds> Total provider timeout (default: 180; 1-3600)\n');
  output.write('  --no-stream         Use non-streaming provider transport\n');
  output.write('  --offline           Use the deterministic OFFLINE / FAKE provider; no key required\n');
  output.write(`  --fixture <name>    Offline fixture: ${OFFLINE_FIXTURES.join(', ')}\n`);
  output.write('  --help              Show this help\n\n');
  output.write('Local limits: specification 512 KiB; diff 512 KiB; combined 1 MiB.\n\n');
  output.write('Examples:\n');
  output.write('  node hy3_showcase.js diff-review --offline --fixture missing-behavior --spec samples/offline/missing-behavior/spec.md --diff samples/offline/missing-behavior/change.diff\n');
  output.write('  node hy3_showcase.js diff-review --spec issue.md --git --output reports/review.md\n');
}

function printCheckHelp(output = process.stdout) {
  output.write('Usage: node hy3_showcase.js check [--timeout <1-120>]\n\n');
  output.write('Uses the documented TokenHub GET /v1/models endpoint. It sends no specification or diff.\n');
}

function progressLine(output, stage, label, offline) {
  output.write(`${offline ? '[OFFLINE / FAKE] ' : ''}[${stage}] ${label}\n`);
}

function displayPath(filePath) {
  if (!filePath || filePath === '-') return filePath;
  const relative = path.relative(process.cwd(), path.resolve(filePath));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return path.basename(filePath);
}

function formatTopLevelError(error) {
  const prefix = error instanceof FriendlyError ? '' : 'Unexpected error: ';
  return `${prefix}${redactSecrets(error?.message || String(error))}`;
}

function handleTopLevelError(error, output = process.stderr) {
  output.write(`\n${formatTopLevelError(error)}\n`);
  return error?.exitCode || 1;
}

if (require.main === module) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => { process.exitCode = handleTopLevelError(error); });
}

module.exports = {
  callModel,
  configureProvider,
  displayPath,
  formatTopLevelError,
  handleTopLevelError,
  isUsableApiKey,
  loadApiKey,
  main,
  parseCheckArgs,
  printCheckHelp,
  printDiffReviewHelp,
  printUsage,
  runCheck,
  runDiffReview,
  runServer,
  withInterruptSignal
};
