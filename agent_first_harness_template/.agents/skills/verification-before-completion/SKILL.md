---
name: verification-before-completion
description: Use before saying work is done, fixed or passing — before "task submit", an approve, or answering an ask. Run the checks and quote the evidence; claims without command output don't count.
---
# Verification before completion

"Should work" is not evidence. Before you submit, approve or report success:

## Checklist
1. **Re-read the acceptance criteria.** For each one, name the evidence that shows it is met.
2. **Run the real checks now**, on the current code — not earlier results:
   - the narrow test(s) for this change,
   - `bash scripts/agent/run_quality_gate.sh` for code tasks,
   - the repro steps from `docs/bugs/<ISSUE>.md` for bug fixes,
   - UI changes: screenshot or recorded steps (`ui-evidence`).
3. **Read the output.** Exit code 0 and the expected test count; no skipped tests you didn't intend;
   no new warnings you introduced.
4. **Check the diff**: `git status`, `git diff --stat` — only intended files, no debug code.
5. **Report with evidence** in the submit summary:
   `... | verified: flutter test test/streak_test.dart (12 passed), gate green, repro steps 1-4 no longer show the bug`

## If something can't be run
Say exactly what was not verified and why ("no iOS simulator here"), what you did instead,
and the risk. Never present an unverified claim as verified.

## Red flags in your own wording
"should", "probably", "I believe it works", "tests should pass" → go run them.
