# Multi-Agent Loop

How work moves through the harness. The loop is `harness/loop.mjs`; the dashboard
(`harness/server.mjs`) can start/stop it.

## Roles

| Role | Instance(s) | Does |
|---|---|---|
| orchestrator | `orchestrator` | Talks with the human, creates/assigns tasks, watches pending work |
| planner | `planner` | Spec + execution plan + dependency-ordered tasks |
| implementer | `dev-1`, `dev-2` | Code changes for one task |
| tester | `tester` | Tests, bug reproduction, verification evidence |
| reviewer | `reviewer` | Approves/rejects submissions; never edits code |
| docs-gardener | `docs` | Docs, indexes, ADR list, tech debt |

Instances are configured in `harness.config.json`; role rules in `agents/<role>.md`.

## Task lifecycle

```txt
todo ──dispatch──▶ in-progress ──agent: task submit──▶ quality gate ──pass──▶ reviewer
  ▲                     │                                   │fail                │approve → done
  │                     └─agent: task block──▶ pending      ▼                    │reject
  └──────── retry with feedback (attempts < max_attempts) ◀─┴────────────────────┘
                                   attempts == max_attempts ──▶ pending + blocker issue
pending ──human answers + moves to todo──▶ todo (attempts reset, blocker issues closed)
```

- A task is **ready** when it is `todo` and every `depends_on` task is `done`.
- Ready tasks are picked by priority (P0 first), then id.
- The agent receives: role rules, harness contract, task, acceptance criteria, recent notes,
  and the feedback from the previous failed attempt.
- `gate: false` / `review: false` in a role's frontmatter skips those steps for that role.

## When the loop stops

- all tasks `done`
- only `pending` tasks (or tasks blocked by them) remain → needs a human
- `max_iterations` dispatches reached
- operator pressed **Stop loop** (or created `.harness/STOP`); running turns finish first

## Parallel work

`loop.max_parallel > 1` runs several agents at once. They share one working tree unless
`loop.use_worktrees: true`, which gives each task its own git worktree and branch
`agent/<TASK>` under `.harness/worktrees/`. Branches are left for you to merge.
With shared tree + parallel, give agents tasks that touch different modules.

## Usage limits

Claude Code and Codex plans have usage limits. When a run fails with a limit message
(e.g. "usage limit reached", "rate limit", HTTP 429), the harness:

1. records the limit for that **runtime** in `.harness/limits.json` (with the reset time when the
   CLI reports one) — every agent on that runtime is paused, because the limit is per account;
2. puts the task back in `todo` **without using an attempt**;
3. keeps the loop waiting instead of failing tasks.

The dashboard shows the warning on each affected agent and asks whether to switch them to another
runtime. Limits clear themselves at the reset time, or with **Mark available**.

## Running one task or issue

- **Run** on a task starts `node harness/loop.mjs --task <ID>`: only that task, ignoring
  dependencies, with the same gate/review/retry cycle. A pending task gets a fresh attempt budget.
- **Run fix** on an issue creates (or reuses) a linked fix task and runs it; the issue is closed
  when the fix task is done. Blocker issues are answered on their task instead.
- **Stop** kills the agent working on that task right away and parks it in `pending`.
- **Retry** (pending tasks) resets attempts, closes the task's blocker issues and runs it again
  (or just requeues it when the loop is already running). CLI: `node harness/cli.mjs task retry <ID>`.

## Agent-to-agent asks (cross-runtime)

Any agent — or you, from a terminal — can call another agent directly and get its answer in the
same turn, whatever runtime each one uses (Claude Code orchestrator → Codex developer, or the reverse):

```bash
node harness/cli.mjs ask dev-1 "Find where streaks are reset and explain the timezone bug" --readonly
node harness/cli.mjs ask dev-2 "Refactor lib/date_utils.dart ..." --background   # → A-xxxx
node harness/cli.mjs ask-result A-xxxx --wait 100
```

- Runs use the target agent's configured runtime/model, show up live on the dashboard
  ("for orchestrator"), appear in Activity, and are stored in `.harness/asks/`.
- Refused up front (exit 4) when the target is busy, its runtime is limited, it is disabled, or the
  nesting depth (`ask.max_depth`, default 1) would be exceeded. The message lists free alternatives.
- A limit hit during the run returns exit 3 and is recorded like any other limit.
- `--readonly` tells the agent not to change anything and, on Claude Code, restricts its tools to
  `ask.readonly_tools`.
- `ask.timeout_s` (default 540) stops a run that takes too long.

No MCP server is needed: asks call the agent CLIs (`claude`, `codex`) through the harness runner.

## Human touchpoints

- Answer `pending` tasks: open the card, write the answer, **Move to Todo**.
- Chat with `orchestrator` to plan work; it creates tasks the loop then executes.
- Chat with any other agent for a quick question or a small direct change. Each chat can use its own
  runtime; **New** starts a fresh conversation, **Save** writes it to `docs/chat-logs/`.
- Change which runtime/model an agent uses by clicking it in the Agents list (writes `harness.config.json`).
- Review merged branches/PRs as usual; the reviewer agent is a filter, not a replacement.
