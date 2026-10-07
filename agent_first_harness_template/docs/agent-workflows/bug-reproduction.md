# Bug Reproduction Workflow

Bugs are fixed in two steps so the fixer never guesses:

```txt
issue (bug) ──issue fix──▶ T-a "Reproduce I-…" (tester) ──done──▶ T-b "Fix I-…" (implementer) ──done──▶ issue done
                               │ writes docs/bugs/I-….md            │ un-skips repro test, fixes root cause,
                               │ adds failing test (skipped)        │ fills "Fix" in the report
                               └─ cannot reproduce → pending, asks human for details
```

## Rules

- The repro report (`docs/bugs/_template.md`) must let someone who never saw the bug reproduce it:
  environment, numbered steps, expected vs actual, evidence, frequency.
- The repro test is committed **skipped with the issue id** so the quality gate stays green until the fix.
  The `Reproduce` task skips the gate; the reviewer checks the report and the test instead.
- The fix task's prompt includes the report; the implementer reproduces first, then fixes the root cause.
- The reviewer re-runs the repro steps/test before approving the fix.
- When the fix task is done, the issue is closed automatically.

## Commands

```bash
node harness/cli.mjs issue add "Streak resets at midnight UTC" --type bug --severity medium --desc "..."
node harness/cli.mjs issue fix I-007              # creates Reproduce + Fix tasks
node harness/cli.mjs issue fix I-007 --no-repro   # obvious bug: only the Fix task
node harness/cli.mjs issue repro I-007 --file docs/bugs/I-007.md --test test/streak_test.dart   # tester
node harness/cli.mjs issue show I-007
```
