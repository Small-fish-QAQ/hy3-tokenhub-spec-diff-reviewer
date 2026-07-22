# Codex + Hy3 staged-diff workflow

The reusable review engine is a standalone CLI. Its primary issue-2 workflow is invoked by Codex CLI after a developer stages a change.

Codex implements or refines code in the repository. The human chooses the specification and remains responsible for deciding exactly what to stage. The thin repository wrapper then reads only the specification and `git diff --cached`; Hy3 produces a structured advisory result; local code validates its schema and every evidence location before publishing Markdown and JSON.

This uses Codex's supported repository instruction mechanism, [`AGENTS.md`](https://developers.openai.com/codex/concepts/customization#agents-guidance), to teach Codex the durable command and safety boundaries. It is not a native Codex extension or plugin.

## Live staged review

```powershell
npm ci
$env:TOKENHUB_API_KEY = "<your-region-scoped-key>"
npm run check
npm run review:staged -- --spec examples/spec.md --output reports/review.md
```

`HY3_BASE_URL` defaults to the officially documented Guangzhou endpoint. Use `https://tokenhub-intl.tencentmaas.com/v1` for a Singapore-region key. `HY3_MODEL` defaults to `hy3`. Keys and endpoints must belong to the same TokenHub region.

## Offline demonstration

```powershell
npm ci
npm run demo:offline
```

The offline provider uses the same argument parsing, input preparation, structured schema, evidence validator, progress path, renderers, and atomic publisher. Every screen and report is labelled `OFFLINE / FAKE`; it never claims to be a Hy3 service result.

## Responsibility boundary

- Codex may implement code and invoke the command when the user asks.
- The reviewer never edits source files or Git state and never falls back to unstaged files.
- Local validation proves JSON shape and that citations exist at the cited input locations. It does not prove that the model's semantic conclusion is correct.
- Hy3 output is advisory. The human owns staging, security review, test execution, and the merge decision.
- Artifact separation, bounded inputs, and local evidence checks reduce prompt-injection risk; they do not eliminate it.
