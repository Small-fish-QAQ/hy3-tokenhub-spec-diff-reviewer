'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { FriendlyError, redactSecrets } = require('./tokenhub');

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SPEC_BYTES = 512 * KIB;
const MAX_DIFF_BYTES = 512 * KIB;
const MAX_COMBINED_BYTES = MIB;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 3600;

function parseDiffReviewArgs(args) {
  const options = {
    stream: true,
    git: false,
    help: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS
  };
  const seen = new Set();

  function markOnce(flag) {
    if (seen.has(flag)) {
      throw new FriendlyError(`Option ${flag} may only be provided once.`);
    }
    seen.add(flag);
  }

  function readValue(flag, index) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new FriendlyError(`Option ${flag} requires a value.`);
    }
    return value;
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--help') {
      markOnce(argument);
      options.help = true;
      continue;
    }

    if (argument === '--no-stream') {
      markOnce(argument);
      options.stream = false;
      continue;
    }

    if (argument === '--git') {
      markOnce(argument);
      options.git = true;
      continue;
    }

    if (argument === '--offline') {
      markOnce(argument);
      options.offline = true;
      continue;
    }

    if (argument === '--spec' || argument === '--diff' || argument === '--output' || argument === '--fixture') {
      markOnce(argument);
      options[argument.slice(2)] = readValue(argument, index);
      index += 1;
      continue;
    }

    if (argument === '--timeout') {
      markOnce(argument);
      const value = readValue(argument, index);
      if (!/^\d+$/.test(value)) {
        throw new FriendlyError(
          `--timeout must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS} seconds.`
        );
      }

      const seconds = Number(value);
      if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
        throw new FriendlyError(
          `--timeout must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS} seconds.`
        );
      }

      options.timeoutSeconds = seconds;
      index += 1;
      continue;
    }

    throw new FriendlyError(`Unknown diff-review option: ${argument}`);
  }

  if (options.help) {
    return options;
  }

  if (!options.spec) {
    throw new FriendlyError('Missing required option: --spec <path>.');
  }

  if (options.diff && options.git) {
    throw new FriendlyError('Choose exactly one diff source: --diff <path>, --diff -, or --git.');
  }

  if (!options.diff && !options.git) {
    throw new FriendlyError('Missing diff source. Use --diff <path>, --diff -, or --git.');
  }

  if (options.fixture && !options.offline) {
    throw new FriendlyError('--fixture is available only with --offline.');
  }

  return options;
}

async function readLimitedFile(filePath, label, limit, fsImpl = fs) {
  let stats;
  try {
    stats = await fsImpl.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FriendlyError(`${label} file not found: ${filePath}`);
    }
    throw new FriendlyError(`Unable to read ${label.toLowerCase()} file ${filePath}: ${error.message}`);
  }

  if (!stats.isFile()) {
    throw new FriendlyError(`${label} path is not a file: ${filePath}`);
  }

  if (stats.size > limit) {
    throw sizeLimitError(label, limit);
  }

  let buffer;
  try {
    buffer = await fsImpl.readFile(filePath);
  } catch (error) {
    throw new FriendlyError(`Unable to read ${label.toLowerCase()} file ${filePath}: ${error.message}`);
  }

  if (buffer.byteLength > limit) {
    throw sizeLimitError(label, limit);
  }

  return buffer.toString('utf8');
}

async function readDiffFromStdin(stdin = process.stdin) {
  const chunks = [];
  let byteLength = 0;

  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > MAX_DIFF_BYTES) {
        throw sizeLimitError('Diff', MAX_DIFF_BYTES);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof FriendlyError) {
      throw error;
    }
    throw new FriendlyError(`Unable to read diff from stdin: ${error.message}`);
  }

  return Buffer.concat(chunks, byteLength).toString('utf8');
}

function readStagedDiff(execFileImpl = execFile, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'git',
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color'],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: MAX_DIFF_BYTES + 1
      },
      (error, stdout, stderr) => {
        if (error) {
          if (
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
            /maxBuffer/i.test(error.message || '')
          ) {
            reject(sizeLimitError('Diff', MAX_DIFF_BYTES));
            return;
          }

          const stderrMessage = stderr ? String(stderr).trim() : '';
          const detail = stderrMessage || error.message || String(error);
          reject(
            new FriendlyError(
              `Unable to read the staged Git diff: ${redactSecrets(detail)}`
            )
          );
          return;
        }

        resolve(stdout || '');
      }
    );
  });
}

async function validateOutputPath(options, dependencies = {}) {
  if (!options.output) {
    return;
  }

  const fsImpl = dependencies.fsImpl || fs;
  const pathImpl = dependencies.pathImpl || path;
  const cwd = dependencies.cwd || process.cwd();
  const platform = dependencies.platform || process.platform;
  const inputPaths = [options.spec];

  if (!options.git && options.diff && options.diff !== '-') {
    inputPaths.push(options.diff);
  }

  const outputCandidates = [];
  for (const outputPath of outputBundlePaths(options.output, pathImpl)) {
    outputCandidates.push(...await comparablePaths(
      outputPath,
      { fsImpl, pathImpl, cwd, platform }
    ));
  }

  for (const inputPath of inputPaths) {
    const inputCandidates = await comparablePaths(
      inputPath,
      { fsImpl, pathImpl, cwd, platform }
    );
    if (inputCandidates.some((candidate) => outputCandidates.includes(candidate))) {
      throw new FriendlyError('--output must not overwrite the specification or diff input file.');
    }
  }
}

function outputBundlePaths(outputPath, pathImpl = path) {
  const extension = pathImpl.extname(outputPath);
  const jsonPath = extension.toLowerCase() === '.md'
    ? `${outputPath.slice(0, -extension.length)}.json`
    : `${outputPath}.json`;
  return [outputPath, jsonPath];
}

async function comparablePaths(filePath, dependencies) {
  const { fsImpl, pathImpl, cwd, platform } = dependencies;
  const resolvedPath = pathImpl.resolve(cwd, filePath);
  const candidates = [normalizeComparablePath(resolvedPath, platform)];

  try {
    const realPath = await fsImpl.realpath(resolvedPath);
    candidates.push(normalizeComparablePath(realPath, platform));
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw new FriendlyError(
        `Unable to validate output path: ${redactSecrets(error.message || String(error))}`
      );
    }
  }

  return [...new Set(candidates)];
}

function normalizeComparablePath(filePath, platform) {
  return platform === 'win32' ? filePath.toLowerCase() : filePath;
}

async function loadDiffReviewInputs(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const stdin = dependencies.stdin || process.stdin;
  const execFileImpl = dependencies.execFileImpl || execFile;
  const cwd = dependencies.cwd || process.cwd();

  const specification = await readLimitedFile(
    options.spec,
    'Specification',
    MAX_SPEC_BYTES,
    fsImpl
  );

  let diff;
  if (options.git) {
    diff = await readStagedDiff(execFileImpl, cwd);
    if (!diff.trim()) {
      throw new FriendlyError(
        'The staged Git diff is empty. Stage changes, pass --diff <path>, or pipe a diff through stdin with --diff -.'
      );
    }
  } else if (options.diff === '-') {
    diff = await readDiffFromStdin(stdin);
  } else {
    diff = await readLimitedFile(options.diff, 'Diff', MAX_DIFF_BYTES, fsImpl);
  }

  validateInputText(specification, 'Specification', MAX_SPEC_BYTES);
  validateInputText(diff, 'Diff', MAX_DIFF_BYTES);

  const combinedBytes = Buffer.byteLength(specification, 'utf8') + Buffer.byteLength(diff, 'utf8');
  if (combinedBytes > MAX_COMBINED_BYTES) {
    throw new FriendlyError(
      `Combined specification and diff exceed the local showcase limit of ${formatBytes(MAX_COMBINED_BYTES)}. This is a showcase safeguard, not a TokenHub service limit.`
    );
  }

  return { specification, diff };
}

function validateInputText(text, label, limit) {
  if (!text || !text.trim()) {
    throw new FriendlyError(`${label} is empty.`);
  }

  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw sizeLimitError(label, limit);
  }
}

function sizeLimitError(label, limit) {
  return new FriendlyError(
    `${label} exceeds the local showcase limit of ${formatBytes(limit)}. This is a showcase safeguard, not a TokenHub service limit.`
  );
}

function formatBytes(bytes) {
  if (bytes === MIB) {
    return '1 MiB';
  }
  return `${bytes / KIB} KiB`;
}

async function writeReportAtomic(outputPath, report, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const pathImpl = dependencies.pathImpl || path;
  const suffix = dependencies.suffix || `${process.pid}-${randomUUID()}`;
  const finalPath = pathImpl.resolve(outputPath);
  const parentPath = pathImpl.dirname(finalPath);
  const temporaryPath = pathImpl.join(parentPath, `.${pathImpl.basename(finalPath)}.${suffix}.tmp`);
  let handle;

  try {
    await fsImpl.mkdir(parentPath, { recursive: true });
    handle = await fsImpl.open(temporaryPath, 'wx');
    await handle.writeFile(report, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsImpl.rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
    throw new FriendlyError(`Unable to save report to ${finalPath}: ${error.message}`);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_COMBINED_BYTES,
  MAX_DIFF_BYTES,
  MAX_SPEC_BYTES,
  MAX_TIMEOUT_SECONDS,
  loadDiffReviewInputs,
  outputBundlePaths,
  parseDiffReviewArgs,
  readDiffFromStdin,
  readLimitedFile,
  readStagedDiff,
  validateOutputPath,
  validateInputText,
  writeReportAtomic
};
