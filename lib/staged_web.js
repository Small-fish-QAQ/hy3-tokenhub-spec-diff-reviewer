'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const {
  MAX_COMBINED_BYTES,
  MAX_DIFF_BYTES,
  MAX_SPEC_BYTES,
  readLimitedFile,
  readStagedDiff,
  validateInputText
} = require('./diff_review');
const { isUsableApiKey, parseHost, parsePort, startReviewServer } = require('./server');
const { FriendlyError, redactSecrets } = require('./tokenhub');

const STAGED_DIFF_COMMAND = 'git diff --cached --no-ext-diff --no-textconv --no-color';
const SPEC_EXAMPLE = 'hy3-review-staged --spec examples/spec.md';
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`]*/g;
const UNC_PATH_PATTERN = /\\\\[^\s"'`]+/g;
const POSIX_USER_PATH_PATTERN = /(?<![:\w])\/(?:home|Users|root|tmp|var|private|mnt)\/[^\s"'`]*/g;

function parseStagedWebArgs(args) {
  const options = { open: true, help: false };
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

    if (argument === '--no-open') {
      markOnce(argument);
      options.open = false;
      continue;
    }

    if (argument === '--spec') {
      markOnce(argument);
      options.spec = readValue(argument, index);
      index += 1;
      continue;
    }

    if (argument === '--port') {
      markOnce(argument);
      options.port = parsePort(readValue(argument, index));
      index += 1;
      continue;
    }

    if (argument === '--host') {
      markOnce(argument);
      options.host = parseHost(readValue(argument, index));
      index += 1;
      continue;
    }

    throw new FriendlyError(
      'Unknown staged review console option. Supported options: --spec <path>, --port <port>, --host <host>, --no-open, --help.'
    );
  }

  if (!options.help && !options.spec) {
    throw new FriendlyError(
      `Missing required option: --spec <path-inside-the-reviewed-repository>. Example: ${SPEC_EXAMPLE}`
    );
  }

  return options;
}

function stripControlCharacters(value) {
  return String(value ?? '').replace(CONTROL_CHARACTERS_PATTERN, '');
}

function sanitizeDisplayText(value, maxLength = 200) {
  return stripControlCharacters(value).trim().slice(0, maxLength);
}

/**
 * Make a lower-level error message safe for terminal display: redact
 * credential shapes, replace every known local path (and separator variants)
 * with a neutral marker, remove anything that still looks like an absolute
 * path, and strip control characters that could spoof terminal output.
 */
function safeLauncherMessage(message, knownPaths = []) {
  let safe = redactSecrets(String(message ?? ''));
  for (const knownPath of knownPaths) {
    for (const variant of pathVariantsOf(knownPath)) {
      safe = safe.split(variant).join('[repository path]');
    }
  }
  safe = safe.replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[local path]');
  safe = safe.replace(UNC_PATH_PATTERN, '[local path]');
  safe = safe.replace(POSIX_USER_PATH_PATTERN, '[local path]');
  return stripControlCharacters(safe);
}

function pathVariantsOf(value) {
  if (typeof value !== 'string' || !value) return [];
  return [...new Set([value, value.split('\\').join('/'), value.split('/').join('\\')])];
}

function isOutsideRelative(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Safe display form of a spec path: repository-relative when the path is
 * inside the reviewed repository, otherwise only the file basename. Never an
 * absolute path or raw user input.
 */
function displaySpecPath(repositoryRoot, resolvedPath, specArg) {
  const relative = path.relative(repositoryRoot, resolvedPath);
  if (relative && !isOutsideRelative(relative)) {
    return sanitizeDisplayText(relative.split(path.sep).join('/'), 500) || 'the supplied spec path';
  }
  return sanitizeDisplayText(path.basename(resolvedPath))
    || sanitizeDisplayText(path.basename(String(specArg ?? '')))
    || 'the supplied spec path';
}

function execGit(args, cwd, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderrText = stderr ? String(stderr) : '';
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

async function resolveRepository(dependencies = {}) {
  const cwd = dependencies.cwd || process.cwd();
  const execFileImpl = dependencies.execFileImpl || execFile;
  const fsImpl = dependencies.fsImpl || fs;

  let topLevel;
  try {
    topLevel = (await execGit(['rev-parse', '--show-toplevel'], cwd, execFileImpl)).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FriendlyError('Git is not available on PATH. Install Git, then rerun the staged review console.');
    }
    const detail = String(error?.stderrText || error?.message || '');
    if (/dubious ownership/i.test(detail)) {
      throw new FriendlyError(
        'Git refused this repository because of dubious ownership. From a trusted shell, mark the repository safe with `git config --global --add safe.directory <repository-root>` and rerun the staged review console.'
      );
    }
    if (/not a git repository/i.test(detail) || !detail.trim()) {
      throw new FriendlyError(
        'The current directory is not inside a Git repository. Run the staged review console from the repository whose staged change should be reviewed.'
      );
    }
    throw new FriendlyError(
      'Unable to locate the Git repository root with `git rev-parse --show-toplevel`. Run the staged review console from a readable Git repository.'
    );
  }

  if (!topLevel) {
    throw new FriendlyError('Git did not report a repository root for the current directory.');
  }

  let root = path.resolve(topLevel);
  try {
    root = await fsImpl.realpath(root);
  } catch (_error) {
    // Boundary checks still apply to the resolved root.
  }

  let branch = null;
  try {
    branch = sanitizeDisplayText(await execGit(['branch', '--show-current'], root, execFileImpl)) || null;
  } catch (_error) {
    branch = null;
  }

  return { root, name: sanitizeDisplayText(path.basename(root)) || 'repository', branch };
}

async function resolveSpecificationWithinRepository(specArg, repositoryRoot, dependencies = {}) {
  const cwd = dependencies.cwd || process.cwd();
  const fsImpl = dependencies.fsImpl || fs;

  if (typeof specArg !== 'string' || !specArg.trim()) {
    throw new FriendlyError(
      `Missing required option: --spec <path-inside-the-reviewed-repository>. Example: ${SPEC_EXAMPLE}`
    );
  }

  const resolved = path.resolve(cwd, specArg);
  const shownPath = displaySpecPath(repositoryRoot, resolved, specArg);
  let stats;
  try {
    stats = await fsImpl.stat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FriendlyError(
        `Specification file not found: ${shownPath}. Pass a spec path that exists inside the reviewed repository.`
      );
    }
    throw new FriendlyError(
      `Unable to read specification file ${shownPath} (${sanitizeDisplayText(error?.code, 40) || 'unknown error'}).`
    );
  }
  if (!stats.isFile()) {
    throw new FriendlyError(`Specification path is not a regular readable file: ${shownPath}.`);
  }

  let realPath;
  try {
    realPath = await fsImpl.realpath(resolved);
  } catch (_error) {
    // Fail closed: without the real location, containment cannot be proven.
    throw new FriendlyError(
      `Unable to verify the real location of the specification file: ${shownPath}. Check file and directory permissions, then rerun the staged review console.`
    );
  }

  const relative = path.relative(repositoryRoot, realPath);
  if (!relative || isOutsideRelative(relative)) {
    throw new FriendlyError(
      `Specification path resolves outside the reviewed repository: ${displaySpecPath(repositoryRoot, realPath, specArg)}. Keep the spec inside the repository, for example --spec examples/spec.md.`
    );
  }

  return { absolutePath: realPath, relativePath: relative.split(path.sep).join('/') };
}

/**
 * Read the explicit spec file and the staged diff of the surrounding Git
 * repository. The metadata this launcher adds (repository basename, branch,
 * repo-relative spec path, fixed diff command) never includes a credential,
 * environment value, or absolute path. The specification and diff artifacts
 * themselves are intentionally passed to the browser verbatim for review, so
 * any secret a user writes into or stages within them is delivered as-is —
 * users must not include or stage secrets in these artifacts.
 */
async function collectStagedBootstrap(options = {}) {
  const dependencies = {
    cwd: options.cwd || process.cwd(),
    execFileImpl: options.execFileImpl || execFile,
    fsImpl: options.fsImpl || fs
  };

  const repository = await resolveRepository(dependencies);
  const specification = await resolveSpecificationWithinRepository(options.spec, repository.root, dependencies);

  let specificationText;
  try {
    specificationText = await readLimitedFile(
      specification.absolutePath,
      'Specification',
      MAX_SPEC_BYTES,
      dependencies.fsImpl
    );
  } catch (error) {
    let message = String(error?.message || 'Unable to read the specification file.');
    for (const variant of pathVariantsOf(specification.absolutePath)) {
      message = message.split(variant).join(specification.relativePath);
    }
    throw new FriendlyError(safeLauncherMessage(message, [repository.root]));
  }

  let diff;
  try {
    diff = await readStagedDiff(dependencies.execFileImpl, repository.root);
  } catch (error) {
    throw new FriendlyError(
      safeLauncherMessage(error?.message || 'Unable to read the staged Git diff.', [repository.root])
    );
  }
  if (!diff.trim()) {
    throw new FriendlyError(
      `No staged changes were found in repository ${repository.name}. Stage the intended change with git add, then rerun the staged review console.`
    );
  }

  validateInputText(specificationText, 'Specification', MAX_SPEC_BYTES);
  validateInputText(diff, 'Diff', MAX_DIFF_BYTES);
  if (Buffer.byteLength(specificationText, 'utf8') + Buffer.byteLength(diff, 'utf8') > MAX_COMBINED_BYTES) {
    throw new FriendlyError(
      'Combined specification and staged diff exceed the local showcase limit of 1 MiB. This is a showcase safeguard, not a TokenHub service limit.'
    );
  }

  return Object.freeze({
    source: 'staged',
    label: 'Staged Git change',
    repository: repository.name,
    branch: repository.branch,
    specPath: stripControlCharacters(specification.relativePath).slice(0, 500),
    diffCommand: STAGED_DIFF_COMMAND,
    specification: specificationText,
    diff,
    preferredMode: 'live'
  });
}

async function runStagedReviewConsole(args = [], dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const options = parseStagedWebArgs(args);

  if (options.help) {
    printStagedWebHelp(stdout);
    return null;
  }

  const environment = loadLauncherEnvironment(dependencies.environment);
  const cwd = dependencies.cwd || process.env.INIT_CWD || process.cwd();
  const bootstrap = await collectStagedBootstrap({
    spec: options.spec,
    cwd,
    execFileImpl: dependencies.execFileImpl,
    fsImpl: dependencies.fsImpl
  });

  const started = await (dependencies.startServer || startReviewServer)({
    port: options.port,
    host: options.host,
    env: environment,
    bootstrap,
    ...dependencies.serverDependencies
  });

  const liveConfigured = isUsableApiKey(String(environment.TOKENHUB_API_KEY || '').trim());
  const branchSuffix = bootstrap.branch ? ` (branch ${bootstrap.branch})` : '';
  stdout.write(`Codex + Hy3 staged review console: ${started.url}\n`);
  stdout.write(`Input source: staged Git change — repository ${bootstrap.repository}${branchSuffix}\n`);
  stdout.write(`Specification: ${bootstrap.specPath} (${countLines(bootstrap.specification)} lines)\n`);
  stdout.write(`Staged diff: ${countLines(bootstrap.diff)} lines from \`${STAGED_DIFF_COMMAND}\`\n`);
  stdout.write(`Review mode: Live / Hy3 preselected${liveConfigured ? '' : ' (no usable TokenHub credential detected)'}\n`);
  if (!liveConfigured) {
    stderr.write(
      'Live / Hy3 cannot run yet: set TOKENHUB_API_KEY in .env (see .env.example), or explicitly select Offline / Fake in the console.\n'
    );
  }
  stdout.write('Bound to loopback only. Press Ctrl+C to stop.\n');

  if (options.open) {
    openBrowserWindow(started.url, {
      ...dependencies,
      onOpenError: () => stdout.write('Automatic browser launch failed. Open the printed URL manually.\n')
    });
  }

  return { server: started.server, url: started.url, bootstrap };
}

function countLines(value) {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
}

function loadLauncherEnvironment(environment) {
  if (environment) return environment;
  require('dotenv').config({ quiet: true });
  return process.env;
}

/**
 * Best-effort default-browser launch of the already validated loopback URL.
 * The URL is built only from a checked loopback host and an integer port, so
 * no user-controlled text reaches the spawned command.
 */
function openBrowserWindow(url, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const spawnOptions = { detached: true, stdio: 'ignore', windowsHide: true };

  try {
    let child;
    if (platform === 'win32') {
      child = spawnImpl('cmd.exe', ['/c', 'start', '', url], spawnOptions);
    } else if (platform === 'darwin') {
      child = spawnImpl('open', [url], spawnOptions);
    } else {
      child = spawnImpl('xdg-open', [url], spawnOptions);
    }
    child.once?.('error', () => dependencies.onOpenError?.());
    child.unref?.();
    return true;
  } catch (_error) {
    dependencies.onOpenError?.();
    return false;
  }
}

function printStagedWebHelp(output = process.stdout) {
  output.write('Usage:\n');
  output.write('  hy3-review-staged --spec <path> [--port <0-65535>] [--host 127.0.0.1] [--no-open]\n');
  output.write('  npm run review:staged:web -- --spec <path>   (inside this checkout)\n\n');
  output.write('Reads the explicit specification file plus the staged Git diff of the current\n');
  output.write('repository, then serves the local browser review console with both inputs\n');
  output.write('preloaded. Live / Hy3 is always preselected; without a usable server credential\n');
  output.write('the console shows an actionable error and Offline / Fake stays a manual choice.\n\n');
  output.write('Required:\n');
  output.write('  --spec <path>   Specification file inside the reviewed repository\n\n');
  output.write('Options:\n');
  output.write('  --port <port>   Loopback port (default: 4173 or HY3_WEB_PORT)\n');
  output.write('  --host <host>   Loopback host: 127.0.0.1, localhost, or ::1\n');
  output.write('  --no-open       Do not launch the default browser automatically\n');
  output.write('  --help          Show this help\n\n');
  output.write(`Diff source is fixed to \`${STAGED_DIFF_COMMAND}\`; the repository is never modified.\n`);
}

module.exports = {
  STAGED_DIFF_COMMAND,
  collectStagedBootstrap,
  openBrowserWindow,
  parseStagedWebArgs,
  printStagedWebHelp,
  resolveRepository,
  resolveSpecificationWithinRepository,
  runStagedReviewConsole,
  safeLauncherMessage,
  sanitizeDisplayText
};
