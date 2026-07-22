# Session timeout readiness specification

1. Return `active` before 30 minutes of inactivity.
2. Return `expired` at or after exactly 30 minutes.
3. Reject a `lastSeen` timestamp later than `now`.
4. Add boundary tests for 29:59 and 30:00.
