#!/usr/bin/env node
'use strict';

const {
  FriendlyError,
  redactSecrets,
  requestChatCompletion
} = require('./lib/tokenhub');
const {
  buildDiffReviewMessages,
  loadDiffReviewInputs,
  parseDiffReviewArgs,
  validateOutputPath,
  writeReportAtomic
} = require('./lib/diff_review');

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

  if (command !== 'diff-review') {
    throw new FriendlyError(`Invalid command: ${command}. Run with --help to see available commands.`);
  }

  await runDiffReview(args.slice(1), dependencies);
  return 0;
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

  writeLine(stderr, 'Reading specification...');
  if (options.git) {
    writeLine(stderr, 'Reading staged diff...');
  } else if (options.diff === '-') {
    writeLine(stderr, 'Reading diff from stdin...');
  } else {
    writeLine(stderr, 'Reading diff...');
  }

  const loadInputs = dependencies.loadDiffReviewInputs || loadDiffReviewInputs;
  const { specification, diff } = await loadInputs(options, dependencies.inputDependencies);
  const getApiKey = dependencies.loadApiKey || loadApiKey;
  const apiKey = getApiKey();
  const messages = buildDiffReviewMessages(specification, diff);

  writeLine(stderr, 'Sending review request to Hy3...');
  writeLine(stderr, '');

  const result = await callModel(
    {
      messages,
      apiKey,
      stream: options.stream,
      timeoutMs: options.timeoutSeconds * 1000,
      temperature: 0.2,
      maxTokens: 1800,
      onText: options.stream ? (text) => stdout.write(text) : undefined
    },
    dependencies
  );

  if (result.finishReason === 'length') {
    if (options.stream && !result.text.endsWith('\n')) {
      stdout.write('\n');
    }
    const error = new FriendlyError(
      'Hy3 stopped because the output token limit was reached. The review is incomplete and was not saved; reduce the input scope and retry.'
    );
    error.suppressLeadingNewline = true;
    throw error;
  }

  if (!options.stream) {
    stdout.write(result.text);
  }

  if (!result.text.endsWith('\n')) {
    stdout.write('\n');
  }

  if (options.output) {
    const saveReport = dependencies.writeReportAtomic || writeReportAtomic;
    const savedPath = await saveReport(options.output, result.text);
    stderr.write(`Saved report to ${savedPath}\n`);
  }

  return result;
}

async function callModel(options, dependencies = {}) {
  const request = dependencies.requestChatCompletion || requestChatCompletion;

  if (dependencies.signal) {
    return request({ ...options, signal: dependencies.signal });
  }

  const controller = new AbortController();
  let interrupted = false;
  const handleInterrupt = () => {
    interrupted = true;
    controller.abort();
  };

  process.once('SIGINT', handleInterrupt);
  try {
    return await request({ ...options, signal: controller.signal });
  } catch (error) {
    if (interrupted) {
      error.exitCode = 130;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
  }
}

function loadApiKey(environment) {
  if (!environment) {
    environment = process.env;
    if (!isUsableApiKey(environment.TOKENHUB_API_KEY)) {
      require('dotenv').config({ quiet: true });
    }
  }
  const apiKey = normalizeApiKey(environment.TOKENHUB_API_KEY);
  if (!isUsableApiKey(apiKey)) {
    throw new FriendlyError(
      'Missing TOKENHUB_API_KEY. Copy .env.example to .env, add your TokenHub key, and run the command again.'
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
  output.write('\n');
  output.write('Usage:\n');
  output.write('  node hy3_showcase.js diff-review --spec <path> (--diff <path> | --diff - | --git) [options]\n');
  output.write('\n');
  output.write('Commands:\n');
  output.write('  diff-review  Compare a written specification with a proposed diff\n');
  output.write('\n');
  output.write('Run `node hy3_showcase.js diff-review --help` for review options and examples.\n');
}

function printDiffReviewHelp(output = process.stdout) {
  output.write('Usage:\n');
  output.write('  node hy3_showcase.js diff-review --spec <path> (--diff <path> | --diff - | --git) [options]\n');
  output.write('\n');
  output.write('Required:\n');
  output.write('  --spec <path>       Issue, requirements, or written specification\n');
  output.write('  --diff <path>       Unified diff file\n');
  output.write('  --diff -            Read a unified diff from standard input\n');
  output.write('  --git               Read only the staged diff from `git diff --cached`\n');
  output.write('                       Choose exactly one of --diff or --git\n');
  output.write('\n');
  output.write('Options:\n');
  output.write('  --output <path>     Save the completed Markdown report after success\n');
  output.write('  --timeout <seconds> Request timeout (default: 180; allowed: 1-3600)\n');
  output.write('  --no-stream         Use the normal non-streaming JSON response path\n');
  output.write('  --help              Show this help\n');
  output.write('\n');
  output.write('Local reviewer safeguards (not TokenHub service limits):\n');
  output.write('  Specification: 512 KiB; diff: 512 KiB; combined: 1 MiB\n');
  output.write('\n');
  output.write('Examples:\n');
  output.write('  node hy3_showcase.js diff-review --spec samples/issue.md --diff samples/change.diff\n');
  output.write('  node hy3_showcase.js diff-review --spec issue.md --diff change.diff --no-stream\n');
  output.write('  git diff | node hy3_showcase.js diff-review --spec issue.md --diff -\n');
  output.write('  node hy3_showcase.js diff-review --spec issue.md --git --output reports/review.md\n');
}

function writeLine(output, text) {
  output.write(`${text}\n`);
}

function formatTopLevelError(error) {
  const prefix = error instanceof FriendlyError ? '' : 'Unexpected error: ';
  return `${prefix}${redactSecrets(error?.message || String(error))}`;
}

function handleTopLevelError(error, output = process.stderr) {
  const leadingNewline = error?.suppressLeadingNewline ? '' : '\n';
  output.write(`${leadingNewline}${formatTopLevelError(error)}\n`);
  return error?.exitCode || 1;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.exitCode = handleTopLevelError(error);
    });
}

module.exports = {
  callModel,
  formatTopLevelError,
  handleTopLevelError,
  loadApiKey,
  main,
  printDiffReviewHelp,
  printUsage,
  runDiffReview
};
