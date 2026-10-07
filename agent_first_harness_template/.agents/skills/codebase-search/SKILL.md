---
name: codebase-search
description: Use when you need to find where something lives in the repo — a symbol, screen, API call, config, string or pattern — quickly and cheaply. Returns paths and line ranges, not whole files.
---
# Codebase search

Search narrow-to-wide and read only what answers the question.

1. **Start with names**: files and folders first — `rg --files | rg -i 'streak|habit'`, or glob `**/*streak*`.
2. **Then content**, most specific term first, scoped to likely folders:
   `rg -n --hidden -g '!**/build/**' -g '!**/node_modules/**' 'class StreakService' lib/ src/`
   - exact symbol → `rg -nw 'StreakService'`; call sites → `rg -n 'streakService\.' `
   - strings shown in the UI → search l10n/arb/json/strings files too
   - config/env → `rg -n 'API_URL|apiUrl' -g '*.{yaml,json,env.example,plist,gradle,kts}'`
3. **Read slices**, not files: open ±30 lines around hits; follow imports one hop at a time.
4. **Stop** when you can answer; don't map the whole codebase.

## Answer format (keep it short)
```
Answer: <one or two sentences>
Files:
- lib/features/streak/streak_service.dart:40-88 — computes streak; resets at UTC midnight (line 61)
- lib/features/home/home_screen.dart:120 — shows the counter
Not found: <what you looked for and where, if anything is missing>
```
Never paste whole files or long outputs back to the caller — paths and line ranges are enough.
