# Task routing requirements

Implement `routeTask(task, allowedTeams)` in `src/route-task.js` for an API that routes incoming work.

The function must:

1. Return an object with these keys on every path: `status`, `owner`, `escalation`, and `reason`.
2. Use `status: "assigned"` only when the category maps to a team present in `allowedTeams`; `owner` must never contain a team outside that allowlist.
3. Return `status: "needs_info"` with `owner: null` when ownership cannot be determined.
4. Treat an empty or whitespace-only title as insufficient information and return `needs_info`.
5. Treat an unknown category as insufficient information; do not route it to a hard-coded fallback owner.
6. For a task with `priority: "high"`, set `escalation` to `"Escalate to the on-call lead"`. Otherwise, set it to `null`.
7. Return stable structured JSON-compatible values without throwing for the boundary cases above.

Known category mappings are `billing` to `payments`, `security` to `security`, and `support` to `support`.

Add tests for a successful route and the boundary cases: empty title, unknown category, mapped team absent from the allowlist, and high priority.
