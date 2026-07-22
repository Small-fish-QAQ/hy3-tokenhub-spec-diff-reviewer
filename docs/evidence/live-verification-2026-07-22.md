# Live TokenHub verification — 2026-07-22

This is a sanitized record of the single bounded live verification run performed after the offline suite passed. Inputs are the self-authored `missing-behavior` sample. No API key, authorization header, absolute path, or environment dump is retained.

## Preflight

Command:

```powershell
npm run check
```

Observed result:

| Field | Value |
| --- | --- |
| Operation | Official authenticated `GET /v1/models`; no specification or diff sent |
| Provider host | `tokenhub.tencentmaas.com` |
| Selected model | `hy3` |
| Model status | `online` |
| Request ID | Not provided |

## Review

Command:

```powershell
node hy3_showcase.js diff-review `
  --spec samples/offline/missing-behavior/spec.md `
  --diff samples/offline/missing-behavior/change.diff `
  --output reports/live-verification.md `
  --timeout 60
```

Observed result:

| Field | Value |
| --- | --- |
| Mode / transport | Live / SSE streaming |
| Generated | `2026-07-22T14:50:02.274Z` |
| Verdict | `needs_information` |
| Coverage | 2 met, 1 partial, 2 missing |
| Findings | Two P1 findings |
| Missing tests | Three |
| Uncertainties | One |
| Finish reason | `stop` |
| Repair attempted | No |
| Schema validation | Passed |
| Evidence validation | Passed |
| Provider request ID | `6c43602c-377a-4801-953b-6f81a9da51b5` |
| Specification SHA-256 | `333cbcb8a82fda0d05943c06306c137f6ad1c938bf015823e7ab9c1cd7755d3d` |
| Diff SHA-256 | `f358c8c3eb27a6661fa68df35b534b6510c32dd990b764ce8ec2c0ac2b632dc2` |
| Specification size | 264 bytes / 9 lines |
| Diff size | 584 bytes / 19 lines |

The two P1 findings identified the strict `>` threshold at exactly 30 minutes and the missing rejection of a future `lastSeen`. The report also cited absent 29:59/30:00 boundary coverage. Local checks establish the cited locations and output contract, not the semantic correctness of every conclusion.

No further live provider review was run for tuning.
