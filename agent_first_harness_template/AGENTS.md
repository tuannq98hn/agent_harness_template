# AGENTS.md

This file is the entry point for AI coding agents working in this repository. Keep it short. Do not turn this file into a full handbook. Link to deeper documents instead.

## Agent Operating Principles

1. Read this file first.
2. Read `ARCHITECTURE.md` before changing code structure.
3. Read the relevant product spec under `docs/product-specs/` before implementing features.
4. Read the relevant execution plan under `docs/exec-plans/active/` before starting a task.
5. Run the project quality gate before marking work complete.
6. Update task status, execution notes, and any affected docs after meaningful changes.
7. Do not silently change architecture, public API contracts, security behavior, or data models without documenting the decision.
8. Prefer small, reviewable changes over large uncontrolled edits.
9. Never commit secrets, API keys, local credentials, or private tokens.
10. When unsure, add a note to the execution plan instead of inventing hidden behavior.

## Multi-Agent Harness

This repo runs several agents with different roles, coordinated by a loop and a local dashboard.

- Your role and rules: `agents/<role>.md` (you are told your agent id and role at start).
- Board state (tasks, issues) lives in `.harness/` and changes only via `node harness/cli.mjs`.
- Finish every loop turn with `task submit <ID> --summary "..."` or `task block <ID> --reason "..."`.
- Never mark a task `done` yourself; the loop does that after the quality gate and review pass.
- Need something from another agent (on any runtime)? `node harness/cli.mjs ask <agent> "..."`.
  When you are the one being asked, just answer: your final message goes back to the caller.
- Need to **find** code (where is X, who calls Y, which config sets Z) across many files? Ask the cheap
  read-only finder instead of searching yourself: `node harness/cli.mjs ask finder "..."`.
  For one quick grep, just grep.
- Skills (how-tos for TDD, debugging, verification, repro reports, UI evidence, search…) live in
  `.agents/skills/`. Your role's recommended skills are listed in your prompt; read one before work it covers.
- How the loop works: `docs/agent-workflows/multi-agent-loop.md`.

## Read First

- `ARCHITECTURE.md` — system architecture and boundaries
- `docs/PRODUCT_SENSE.md` — product intent and user value
- `docs/QUALITY_SCORE.md` — current quality status and improvement areas
- `docs/RELIABILITY.md` — reliability expectations
- `docs/SECURITY.md` — security rules
- `docs/validation/quality-gates.md` — definition of done
- `docs/agent-workflows/feature-implementation-loop.md` — default implementation workflow
- `docs/agent-workflows/bug-fix-loop.md` — default bug fixing workflow

## Default Completion Criteria

A task is not complete until:

- The requested change is implemented.
- Relevant tests, checks, or manual verification steps are run.
- Known limitations are documented.
- Affected docs/specs/status files are updated.
- No unrelated files are modified.

## Recommended Commands

Start by inspecting available scripts:

```bash
ls scripts/agent scripts/test scripts/ci
```

Run the default quality gate:

```bash
bash scripts/agent/run_quality_gate.sh
```

Bootstrap local development if needed:

```bash
bash scripts/agent/bootstrap.sh
```

Board commands (tasks, issues, notes, submit, block):

```bash
node harness/cli.mjs help
node harness/cli.mjs task list
node harness/cli.mjs task note T-001 "what I just did"
```
