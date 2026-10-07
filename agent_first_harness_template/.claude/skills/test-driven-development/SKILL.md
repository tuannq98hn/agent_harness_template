---
name: test-driven-development
description: Use when implementing a feature or bug fix that can be tested — write the failing test first, watch it fail for the right reason, then write the minimum code to pass (red-green-refactor).
---
# Test-driven development

A test you never saw fail proves nothing. Red → green → refactor, in small steps.

## Cycle
1. **Red** — write one test for the next small behaviour. Name it after the behaviour:
   `"shows an error when the email is empty"`. Run it. It must fail, and for the expected reason
   (an assertion), not because of a typo or missing import.
2. **Green** — write the simplest code that makes it pass. No extra features, no "while I'm here".
3. **Refactor** — clean up names and duplication with all tests green. Run them again.
4. Repeat for the next behaviour (success, error, empty, edge cases from the spec).

## For bug fixes
- The repro test comes first: it fails on the current code because of the bug.
  (In this repo the tester may have added it skipped with the issue id — remove the skip.)
- After the fix it passes and stays as a regression test.

## What to test where
| Layer | Test type | Example |
|---|---|---|
| Domain / use case | unit | streak rules, validation, mapping |
| State (ViewModel/Bloc/store) | unit with fakes | loading → success / error transitions |
| UI component / screen | widget / component | renders states, buttons call the right action |
| Flow across modules | integration | sign-in → home, sync round-trip |

Prefer fakes over deep mocks; test behaviour through public APIs, not private details.

## Commands (adapt to the stack)
`flutter test path/to/x_test.dart` · `npm test -- x.test.ts` · `pytest tests/x_test.py -k name` ·
`./gradlew testDebugUnitTest --tests '*X*'` · `xcodebuild test -only-testing:Target/XTests`

## When not to force it
Pure layout tweaks, generated code, or spikes: say so in a task note and verify another way
(see `ui-evidence`). Never delete or weaken a test to get green.
