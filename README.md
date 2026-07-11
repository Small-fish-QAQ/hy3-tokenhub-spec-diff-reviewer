# Hy3 TokenHub Spec-to-Diff Reviewer

Use Hy3 to answer a practical review question:

> **Does this proposed diff satisfy the written requirements?**

This reusable CLI compares a specification with a unified diff and produces a structured Markdown PR-readiness report through Tencent Cloud TokenHub.

Use it with:

- your own specification and diff files;
- a diff piped through standard input; or
- changes already staged in Git.

The generated report includes:

- an executive verdict;
- requirement-by-requirement coverage;
- evidence-grounded P0-P3 findings;
- missing tests;
- uncertainties; and
- recommended next steps.

```text
Written specification
        +
Proposed unified diff
        |
        v
Hy3 through Tencent Cloud TokenHub
        |
        v
Markdown PR-readiness report
```

## Quick Start

Run the bundled specification and diff from PowerShell:

```powershell
node .\hy3_showcase.js diff-review `
  --spec .\samples\issue.md `
  --diff .\samples\change.diff
```

Or use the focused npm command:

```powershell
npm.cmd run review:sample
```

Both commands make a live request and send the supplied specification and diff to the remote TokenHub service.

> [!NOTE]
> The bundled sample intentionally contains an incomplete implementation. Its expected verdict is `Not ready`, allowing the reviewer to demonstrate requirement coverage, uncertainty handling, prioritized findings, and missing-test detection.

## Demo

### Streaming CLI Review

Hy3 reads the supplied specification and diff, then streams a structured PR-readiness report directly to the terminal.

[![Hy3 Spec-to-Diff Reviewer streaming in PowerShell](docs/assets/hy3-spec-to-diff-terminal.png)](docs/assets/hy3-spec-to-diff-demo.mp4)

[Watch the short streaming demo](docs/assets/hy3-spec-to-diff-demo.mp4)

### Rendered Markdown Report

A completed review can be saved and rendered as Markdown, including the executive verdict, requirement coverage matrix, and prioritized findings.

![Rendered Hy3 PR-readiness report](docs/assets/hy3-spec-to-diff-report.png)

## Requirements and Installation

You need:

- Node.js 18 or later; and
- a Tencent Cloud TokenHub API key with access to the `hy3` model.

Install the existing dependency versions:

```powershell
npm.cmd install
```

Create a private local environment file from the tracked placeholder:

```powershell
Copy-Item .env.example .env
```

Replace the placeholder locally. Do not commit or share this file.

You can instead supply `TOKENHUB_API_KEY` through your shell or secret manager.

Credentials are loaded lazily. Help commands, argument errors, input-validation failures, and output-path collision failures do not require an API key.

### Service Boundary

The reviewer is configured for the Guangzhou / China-mainland TokenHub service boundary:

- endpoint: `https://tokenhub.tencentmaas.com/v1/chat/completions`
- model: `hy3`

Use a TokenHub key provisioned for that same boundary.

Singapore / global compatibility has not been verified, and the CLI does not provide an endpoint or region-selection option.

Streaming and non-streaming execution have both been manually verified with the Guangzhou service boundary.

## CLI

Show the supported command and its options:

```powershell
node .\hy3_showcase.js --help
node .\hy3_showcase.js diff-review --help
```

The command shape is:

```text
node hy3_showcase.js diff-review --spec <path> (--diff <path> | --diff - | --git) [options]
```

`--spec <path>` must point to a non-empty written issue, requirement set, or other specification.

Choose exactly one diff source:

- `--diff <path>`
- `--diff -`
- `--git`

### Review Files

Use any specification and unified diff files:

```powershell
node .\hy3_showcase.js diff-review `
  --spec .\path\to\issue.md `
  --diff .\path\to\change.diff
```

### Read a Diff from Standard Input

Pass `--diff -` to read the proposed diff from standard input:

```powershell
git diff | node .\hy3_showcase.js diff-review `
  --spec .\path\to\issue.md `
  --diff -
```

### Review Staged Git Changes

Pass `--git` to review only `git diff --cached`:

```powershell
node .\hy3_showcase.js diff-review `
  --spec .\path\to\issue.md `
  --git
```

The command never falls back to unstaged changes.

If the staged diff is empty, stage the intended changes, use `--diff <path>`, or pipe a diff with `--diff -`.

## Streaming, Output, and Cancellation

Streaming is enabled by default.

Generated Markdown is written incrementally to stdout, while input progress, request diagnostics, and saved-path notices go to stderr. This separation allows report content to be redirected without mixing in status messages.

Use the normal non-streaming response path when needed:

```powershell
node .\hy3_showcase.js diff-review `
  --spec .\samples\issue.md `
  --diff .\samples\change.diff `
  --no-stream
```

The corresponding npm convenience command is:

```powershell
npm.cmd run review:sample:no-stream
```

### Truncated Responses

The CLI checks the model finish reason before treating a review as complete.

If TokenHub reports:

```text
finish_reason: "length"
```

the review is considered incomplete.

In that case:

- the command exits with a non-zero status;
- the user is asked to reduce the input scope and retry;
- no `--output` report is published;
- an existing output report is left unchanged;
- streaming text already shown in the terminal may be partial; and
- non-streaming incomplete text is not printed.

### Timeout

Set a request timeout in whole seconds with:

```text
--timeout <seconds>
```

The default is 180 seconds. Accepted values range from 1 through 3600.

### Cancellation

Press `Ctrl+C` to cancel an in-progress request.

The request is aborted and the CLI exits with cancellation status instead of continuing in the background.

### Save a Completed Report

Use `--output <path>` to stream to the terminal and publish the complete report after a successful response:

```powershell
node .\hy3_showcase.js diff-review `
  --spec .\samples\issue.md `
  --diff .\samples\change.diff `
  --output .\reports\hy3-review.md
```

Parent directories are created when needed.

Publication is atomic, so a failed, interrupted, or truncated request does not expose a partial new report or replace an existing report.

The reviewer also rejects output paths that resolve to the specification or file-based diff input, including normalized path aliases, so input files cannot be overwritten accidentally.

## Local Input Safeguards

The CLI enforces local byte limits before contacting TokenHub:

| Input | Maximum |
| --- | ---: |
| Specification | 512 KiB |
| Diff | 512 KiB |
| Combined specification and diff | 1 MiB |

These safeguards keep local runs predictable. They are not TokenHub service limits.

Empty specifications and diffs are also rejected.

## Security and Privacy

- The complete supplied specification and diff are sent to the remote Tencent Cloud TokenHub service. Review them for secrets, personal data, proprietary code, and other sensitive material before running the command.
- Keep `TOKENHUB_API_KEY` out of source files, samples, logs, screenshots, and generated reports. `.gitignore` excludes `.env`.
- Generated reports may repeat sensitive material from the supplied inputs. Inspect reports before saving or sharing them.
- Expected error messages are sanitized, authorization values are redacted, and response headers are not printed.
- Reading files, standard input, and staged Git changes does not modify source code or Git state.
- `--output` is the only report-writing operation.
- Git review mode uses only the staged diff and disables external diff drivers, text conversion, and colored output.
- The reviewer does not gain automatic repository access and does not scan, edit, stage, commit, or push code.
- The TokenHub endpoint is fixed rather than supplied through an arbitrary URL option.

## Limitations

- Hy3 sees only the supplied specification and unified diff.
- It cannot verify omitted surrounding code, runtime behavior, or test results.
- Findings may be incomplete or mistaken.
- Use the report alongside human review and deterministic tests.
- A generated review is not proof of security, correctness, or requirement completion.
- The CLI does not currently select a different TokenHub region or endpoint.
- The tool produces advisory review output and does not modify or apply code changes.

## Offline Tests

The test suite uses injected requests and local fixtures. It does not require a TokenHub key and does not make a live TokenHub request:

```powershell
npm.cmd test
```

The suite currently covers:

- argument parsing and help;
- file, stdin, and staged-Git input;
- path normalization and output collisions;
- atomic report publication;
- streaming and non-streaming responses;
- SSE parsing and chunk boundaries;
- timeout and cancellation behavior;
- truncated-response handling;
- secret redaction;
- API-key normalization;
- the review prompt contract; and
- Node.js 18 compatibility.

## Project Scope

This project deliberately stays focused on one read-only workflow:

```text
Specification + Diff -> Hy3 Review -> Markdown Report
```

It does not implement:

- automated code modification;
- patch application;
- repository scanning;
- agent loops;
- Git staging or committing;
- CI merge gating; or
- a web interface.

Keeping the scope narrow makes the tool easier to understand, audit, and reuse.

## License

This project is distributed under the [ISC License](LICENSE).

The software is provided as-is, without warranty.
