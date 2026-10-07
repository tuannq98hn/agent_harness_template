---
name: systematic-debugging
description: Use when a test fails, a bug is reported, a build/gate breaks or behaviour is unexpected — before proposing any fix. Find the root cause with evidence first; no guess-and-check patches.
---
# Systematic debugging

Fixing a symptom you don't understand creates the next bug. Work in four phases and do not skip ahead.

## 1. Observe (no code changes yet)
- Read the **whole** error: message, stack trace, file:line, the first failure (not the last).
- Reproduce it reliably. Write down the exact command/steps and how often it fails.
  If a repro report exists (`docs/bugs/<ISSUE>.md`), follow it exactly.
- Check what changed recently: `git log --oneline -15 -- <area>`, `git diff`.

## 2. Narrow down
- Find the boundary where good data turns bad: add temporary logging/asserts at each layer
  (UI → state → use case → repository → API/DB) and run once.
- Compare with a working case (another screen, platform, input, older commit). List every difference.
- Bisect when it used to work: `git bisect` or by toggling the suspect change.

## 3. Hypothesis → test
- State one hypothesis in a sentence: "X is null because Y runs before Z".
- Make the **smallest** change or experiment that proves or disproves it. One variable at a time.
- Disproved? Revert the experiment and form the next hypothesis. Don't stack guesses.

## 4. Fix the cause
- Write a failing test that captures the cause (see `test-driven-development`).
- Fix at the source, not where the symptom appeared. Remove temporary logging.
- Look for the same pattern elsewhere (sibling screens, the other platform) and note it.
- Record root cause + fix in the task note (and the Fix section of the bug report).

## Stop signals
- Third fix attempt failed → stop patching. The model of the problem is wrong; go back to phase 1,
  question the architecture, or `task block` with what you know.
- "It works now but I don't know why" is not done.
