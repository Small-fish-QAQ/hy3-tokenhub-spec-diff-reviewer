# Updated ≤60-second demo plan

Target duration: 50–55 seconds. Run `npm run check` first. Record live only after the preflight succeeds; otherwise record the deterministic offline path and keep the `OFFLINE / FAKE` labels visible. Never splice, speed up, or relabel a fake result as live.

## Three demonstrable workflows

1. **Recommended real workflow — staged browser review.** After the one-time `npm link` setup inside the showcase checkout, run from any Git repository with a staged change:

   ```powershell
   hy3-review-staged --spec examples/spec.md
   ```

   The command reads the explicit spec file and the staged diff (fixed read-only `git diff --cached --no-ext-diff --no-textconv --no-color`), starts the loopback console, preloads both inputs, and marks the source as a **STAGED GIT CHANGE**. **Live / Hy3 is always preselected**; without a usable server credential the console shows an actionable error, and Offline / Fake stays an explicit manual choice. Inside the showcase checkout, `npm run review:staged:web -- --spec examples/spec.md` is the equivalent development form.

2. **Deterministic offline browser demo.**

   ```powershell
   npm ci
   npm run serve
   ```

   Open the printed loopback URL, select **Load sample**, keep **Offline / Fake** selected, then **Start review**. This proves reproducibility and the local schema/evidence pipeline; it is a deterministic local fake, not a real Hy3 call.

3. **Historical live evidence.** The existing 31-second MP4 (`docs/assets/hy3-spec-to-diff-demo.mp4`) is real live CLI evidence recorded against an earlier revision, before the structured-schema, evidence, and browser upgrades. Keep it, describe it exactly that way, and never present it as the current browser/schema workflow.

## Inputs and expected result

- Specification: `samples/offline/missing-behavior/spec.md` (copy it to `examples/spec.md` in the disposable repository)
- Implementation: the four-line `sessionStatus` from `samples/offline/missing-behavior/change.diff`
- Expected verdict: `NOT READY`
- Expected coverage: `2/5 met` — R1 and R2 are `MET`; R3, R4, and R5 are `MISSING`
- Expected findings: two P1 defects — strict `>` misses expiration at exactly 30:00, and a future `lastSeen` is accepted instead of rejected
- Expected missing tests: 29:59 active, exactly 30:00 expired, and future `lastSeen > now` rejection

## Live recording setup

One-time preparation inside the showcase checkout, off screen:

```powershell
npm ci
npm run check
npm link
```

`npm link` installs the `hy3-review-staged` executable, so no absolute showcase path has to appear on screen. Then create a self-authored staged sample in a disposable local Git repository or worktree — never a work repository — and record from inside it:

```powershell
git init hy3-staged-demo; cd hy3-staged-demo
# Copy the sample spec to examples/spec.md and create src/session.js with the
# four added lines from samples/offline/missing-behavior/change.diff.
git add src/session.js
hy3-review-staged --spec examples/spec.md
```

The reviewed repository is the Git repository containing the directory where the command runs. The launcher prints only the repository basename, branch, relative spec path, and line counts — verify no absolute path appears before recording. (Without linking, `npm run --prefix <showcase-checkout> review:staged:web -- --spec examples/spec.md` behaves the same, but the command line itself would show the checkout path, so prefer the linked executable on screen.)

If the preflight fails, fall back to workflow 2 and keep every `OFFLINE / FAKE` label in frame.

## Shot list

| Time | Screen | Expected visible state |
| --- | --- | --- |
| 0–6 s | Terminal | `hy3-review-staged --spec examples/spec.md` plus the sanitized launcher summary (staged Git change, spec path, diff line count, Live / Hy3) |
| 6–14 s | Browser opens | Preloaded specification and staged diff, `STAGED GIT CHANGE` banner, `LIVE` badge, **Review with Hy3** action |
| 14–18 s | Start | Select **Review with Hy3**; Cancel enabled; duplicate start disabled |
| 18–34 s | Progress | Input validation → requirement mapping → diff parsing → provider call → schema validation → evidence verification |
| 34–47 s | Result | `NOT READY`, `2/5 met`, R3/R4/R5 `MISSING`, two P1 findings, three missing tests, expanded spec/diff evidence |
| 47–55 s | Provenance | mode/model/host, spec and diff hashes, schema passed, evidence passed, Markdown/JSON download controls |

## Recording checklist

- Capture at 1440×900 or 1920×1080 with browser zoom at 100%.
- Show no API key, authorization header, `.env` contents, username, absolute path, unrelated branch, dirty-worktree noise, notifications, bookmarks, or secrets.
- Keep the mode badge (`LIVE` or `OFFLINE / FAKE`) visible for the whole result sequence.
- Expand both P1 evidence groups; confirm the strict `>` line and the future-timestamp elapsed/return path.
- Do not imply that local evidence validation proves semantic correctness: it verifies citation integrity and structure, while Hy3 supplies the semantic review in Live mode.
- Exercise Cancel once before the final take, then relaunch for a clean run.
- Confirm both downloads contain the same verdict, R1–R5 status map, two P1 findings, three missing tests, and hashes before recording.
- Check the browser console for errors and the server terminal for unhandled rejections.
- Keep the final export at or below 60 seconds.

The existing 31-second MP4 is historical live CLI evidence from an earlier revision. It must not be represented as the updated browser/schema workflow.
