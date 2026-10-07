---
name: bug-repro-report
description: Use when asked to reproduce a bug or a "Reproduce I-…" task — produce docs/bugs/<ISSUE>.md that lets someone who never saw the bug reproduce it, plus a skipped failing test.
---
# Bug reproduction report

The fixer will only have your report. Make it impossible to misunderstand.

1. `cp docs/bugs/_template.md docs/bugs/<ISSUE>.md` and fill it **while** you work.
2. **Environment** — platform + OS version, device/emulator model, app version/build/flavor,
   commit (`git rev-parse --short HEAD`), feature flags, test account/data (never real secrets).
3. **Steps** — numbered, each one action, with exact commands or exact taps and typed text.
   Start from a clean state (fresh install / cleared data / logged out) and say so.
4. **Expected vs actual** — expected per spec/design (link it); actual with the exact error,
   stack trace or log lines (trimmed), plus a screenshot path when visual (`ui-evidence`).
5. **Frequency & scope** — always / N of M runs; what does NOT trigger it (other device, offline, other data).
6. **Minimise** — remove steps until the bug disappears; keep the last set that still shows it.
7. **Automate** — a failing test (unit → widget → integration) that shows the bug, committed
   **skipped with the issue id** so the gate stays green. Note its path.
8. **Suspect area** — file:line with your reasoning, clearly marked as a guess.
9. Register: `node harness/cli.mjs issue repro <ISSUE> --file docs/bugs/<ISSUE>.md --test <path|none>`.

Can't reproduce after a real effort? Record every attempt (devices, data, runs), set `Reproduced: no`,
register with `--not-reproduced`, and block asking for the specific missing information.
