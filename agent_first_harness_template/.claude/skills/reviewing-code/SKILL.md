---
name: reviewing-code
description: Use when reviewing a submitted change, diff or pull request — check it against the task's acceptance criteria and project rules, and give an approve/reject verdict with ordered, actionable feedback.
---
# Reviewing code

Your job is to catch what would hurt users or the codebase, not to restyle it.

## Order of checks (stop early if something blocks)
1. **Scope** — `git diff --stat`: only files the task needs; nothing half-done.
2. **Acceptance criteria** — each one demonstrably met: a test, command output or screenshot. Claims don't count.
3. **Correctness** — read the logic: off-by-one, null/empty, error paths, async races, time zones,
   locale, retries/duplicates, platform differences (Android/iOS, browser).
4. **Tests** — new behaviour has tests that would fail without the change; nothing weakened or skipped.
5. **Architecture** — boundaries in `ARCHITECTURE.md` respected; no SDK/network calls from UI; no new dependency without an ADR.
6. **Security & privacy** — no secrets/PII in code or logs; input validated; auth unchanged unless intended.
7. **Docs** — spec, env reference, test matrix, bug report sections updated when behaviour changed.

## Writing feedback
- Numbered, most important first: `1) lib/x.dart:42 — empty list crashes at first(); return early → add a test for []`.
- Say what to do, not just what is wrong. Separate **blocking** from **nit**.
- Style-only nits never block. Out-of-scope problems become issues, not rejections.

## Verdict
Approve only when you would ship it yourself. Otherwise reject with the list above.
