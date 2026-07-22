# Updated ≤60-second demo plan

Target duration: 50–55 seconds. Record live only after `npm run check` succeeds; otherwise record the deterministic offline path and keep the `OFFLINE / FAKE` labels visible.

## Inputs

- Specification: `samples/offline/missing-behavior/spec.md`
- Diff: `samples/offline/missing-behavior/change.diff`
- Expected offline verdict: `NOT READY`
- Expected gap: expiration must occur at exactly 30 minutes
- Expected missing test: 29:59 / 30:00 boundary coverage

## Offline recording command

```powershell
npm ci
npm run serve
```

Open the printed loopback URL, select **Load sample**, leave **Offline / Fake** selected, then start recording.

## Live recording command

Use only a self-authored staged sample in a disposable local Git worktree:

```powershell
npm run check
npm run review:staged -- --spec examples/spec.md --output reports/review.md
```

Never place the API key, authorization header, `.env`, or full absolute path on screen.

## Shot list

| Time | Screen | Expected visible state |
| --- | --- | --- |
| 0–5 s | Browser header | “Codex + Hy3: does this implementation satisfy the specification?” plus mode/model/validation badges |
| 5–12 s | Specification + diff | Exact 30-minute boundary requirement and the `>` implementation omission |
| 12–18 s | Start | Start review; Cancel enabled; duplicate Start disabled |
| 18–35 s | Progress | Input validation → requirement mapping → diff parsing → provider → schema validation → evidence verification |
| 35–48 s | Result | `NOT READY`, one P1 gap, boundary test missing, coverage matrix, expanded spec/diff evidence |
| 48–55 s | Provenance | mode/model/host, spec and diff hashes, schema/evidence passed, saved/download controls |

## Recording checklist

- Capture at 1440×900 or 1920×1080 with browser zoom at 100%.
- Show no username, absolute path, unrelated branch, dirty-worktree noise, notifications, bookmarks, or secrets.
- Keep the mode badge visible for the whole result sequence.
- Expand one evidence item; do not imply local validation proves semantics.
- Exercise Cancel once before the final take, then reload the sample for a clean run.
- Confirm both downloads contain the same verdict and hashes before recording.
- Check the browser console for errors and the server terminal for unhandled rejections.
- Keep the final export at or below 60 seconds; do not speed up or splice a fake live result.

The existing 31-second MP4 is historical live CLI evidence. It must not be represented as the updated browser/schema workflow.
