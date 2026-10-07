# Agents

Each file here defines one **role**. `harness.config.json` creates **agent instances**
from roles (e.g. `dev-1` and `dev-2` are both `implementer`).

The frontmatter is compatible with Claude Code subagents (`name`, `description`,
`tools`, `model`), so you can also copy these files to `.claude/agents/` if you want
to call them as subagents inside one interactive Claude Code session:

```bash
mkdir -p .claude/agents && cp agents/*.md .claude/agents/ && rm .claude/agents/README.md
```

Harness-only fields:

| Field | Meaning |
|---|---|
| `skills` | comma list of skills in `.agents/skills/` recommended for this role (listed in its prompt) |
| `readonly` | `true` = asks to this role always run read-only |
| `gate` | `false` = the loop skips the quality gate for tasks of this role |
| `review` | `false` = the loop skips the reviewer step for tasks of this role |

## Roles at a glance

| Role | Gets | Produces | Hands off to |
|---|---|---|---|
| orchestrator | your requests (chat), board health | tasks with roles, deps, criteria; bug pairs | everyone (via the board) |
| planner | "Plan X" tasks | spec, execution plan, ADR, ordered tasks | implementers, testers |
| implementer | one code task / "Fix I-…" | small verified change; Fix section in the bug report | reviewer |
| tester | "Reproduce I-…", test/verify tasks | `docs/bugs/I-….md`, skipped repro test, test matrix | implementer (fix), reviewer |
| reviewer | each submission (from the loop) | approve / reject with ordered feedback | loop (done or retry) |
| docs-gardener | gardening tasks | accurate indexes, plans moved, tech debt tidy | — |

## Rules every agent follows

1. Read `AGENTS.md` first, then the docs it points to for the current task.
2. Board state (tasks, issues) changes only through `node harness/cli.mjs`.
3. One task at a time. Stay inside the task's scope; new work becomes a new task or issue.
4. Finish every turn with `task submit` or `task block`. Never mark a task `done` yourself.
5. When unsure, block with a concrete question instead of guessing.
6. Never touch secrets, signing keys, store credentials, or production config.

## Status meaning

| Status | Tasks | Issues |
|---|---|---|
| `todo` | ready (or waiting on `depends_on`) | open, nobody on it |
| `in-progress` | an agent owns it right now | someone is fixing it |
| `done` | gate + review passed | fixed and verified |
| `pending` | waiting for a human decision/answer | waiting for info or a decision |

## Adding a role

1. Create `agents/<role>.md` with the frontmatter below.
2. Add an instance to `harness.config.json` → `agents`.
3. Create tasks with `--role <role>`.

```md
---
name: <role>
description: <one line: when to use this agent>
tools: Read,Grep,Glob,Bash
skills: codebase-search, verification-before-completion
gate: true
review: true
---
# Role: ...
```
