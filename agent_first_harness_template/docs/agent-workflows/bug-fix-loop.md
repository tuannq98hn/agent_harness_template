# Bug Fix Loop

Use this workflow for defects, regressions, crashes, policy issues, and incorrect behavior.

Bugs with a repro report: see `bug-reproduction.md` — start from `docs/bugs/<ISSUE>.md`.

## Loop

1. Reproduce or describe the failure precisely (follow the repro report when there is one).
2. Identify expected vs actual behavior.
3. Locate the smallest responsible area.
4. Add or update a failing test when practical.
5. Fix the root cause, not only the symptom.
6. Run targeted checks.
7. Run the quality gate.
8. Document the cause, fix, and prevention.

## Bug Report Template

```md
## Bug

## Environment

## Steps to Reproduce

## Expected

## Actual

## Root Cause

## Fix

## Verification

## Follow-up
```
