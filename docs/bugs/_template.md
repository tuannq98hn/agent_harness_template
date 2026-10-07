# I-XXX: <one-line symptom>

- Issue: I-XXX · Severity: <low|medium|high|critical> · Reported by: <who> · Date: YYYY-MM-DD
- Reproduced: <yes | no | sometimes (N of M runs)>
- Reproduced by: <agent> on commit `<git rev-parse --short HEAD>`
- Repro test: `<path/to/test>` (skipped with "I-XXX" until fixed) | none — <why>

## Environment

- Platform / OS: <Android 14 emulator (Pixel 7, API 34) | iOS 17.5 simulator | Chrome 129 on macOS | …>
- App version / build: <version, build number, flavor/scheme>
- Config / flags / feature toggles: <…>
- Test data / account: <fake test account, seed data — never real secrets>

## Steps to reproduce

1. <exact command, or exact taps: "Open app → Home → tap '+' → …">
2. <…>
3. <…>

## Expected

<what should happen, per spec/design: link the spec section if there is one>

## Actual

<what happens instead>

```text
<error message / stack trace / relevant log lines, trimmed>
```

## Frequency and scope

- Happens: <always | N of M runs | only after …>
- Does NOT happen when: <other device, other data, offline, …>

## Suspected area (guess)

- `<file>:<line>` — <why you suspect it>. This is a guess, not a diagnosis.

## Fix   <!-- implementer fills this -->

- Root cause: <what was wrong and why, file:line>
- Change: <what was changed> · Task: T-XXX · Commit: `<sha>`
- Same pattern elsewhere: <checked where / found what>

## Verification   <!-- tester or reviewer fills this -->

- Commit: `<sha>` · Ran: <repro test, steps, devices> · Result: <fixed / still reproduces>
