# Multi-Agent Loop

How work moves through the harness. The loop is `harness/loop.mjs`; the dashboard
(`harness/server.mjs`) can start/stop it.

## Roles

| Role | Instance(s) | Does |
|---|---|---|
| orchestrator | `orchestrator` | Talks with the human, creates/assigns tasks, watches pending work |
| planner | `planner` | Spec + execution plan + dependency-ordered tasks |
| implementer | `dev-1`, `dev-2` | Code changes for one task |
| tester | `tester` | Reproduces bugs into `docs/bugs/`, tests, verification evidence |
| reviewer | `reviewer` | Approves/rejects submissions; never edits code |
| docs-gardener | `docs` | Docs, indexes, ADR list, tech debt |
| explorer | `finder` | Read-only search on a mid-size model; answers `ask` with paths + line ranges |

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

## Time and schedule (Settings → Time / Schedule)

| Setting | Config key | Effect |
|---|---|---|
| Stop the loop after N minutes | `loop.max_run_minutes` (0 = no limit) | no new dispatches after N minutes; running turns finish |
| Stop a silent agent after N minutes | `loop.idle_timeout_s` | kills a turn that prints nothing (e.g. stuck on a prompt) |
| Longest single agent turn | `loop.turn_timeout_s` | kills a turn that runs too long |
| Start automatically | `schedule.enabled/start/days` | the dashboard starts the loop at `start` on those weekdays |
| Stop at | `schedule.stop` | the dashboard asks the loop to stop (gracefully) |

The schedule uses the computer's local clock and only works while the dashboard (`./dashboard.sh`)
is running — it is the scheduler. Each start/stop happens at most once per day.

## Bugs: reproduce, then fix

See `bug-reproduction.md`. `issue fix <ID>` (or **Run fix** / **Reproduce + fix** on the dashboard)
creates a tester task "Reproduce I-…" and an implementer task "Fix I-…" that depends on it. The
reproduce task skips the quality gate (its test is intentionally failing and skipped); the fix task's
prompt contains the repro report. The issue closes when the fix task is done.

## Usage limits

Claude Code and Codex plans have usage limits. When a run fails with a limit message
(e.g. "usage limit reached", "rate limit", HTTP 429), the harness:

1. records the limit for that **runtime** in `.harness/limits.json` (with the reset time when the
   CLI reports one) — every agent on that runtime is paused, because the limit is per account;
2. puts the task back in `todo` **without using an attempt**;
3. keeps the loop waiting instead of failing tasks.

The dashboard shows the warning on each affected agent and asks whether to switch them to another
runtime. Limits clear themselves at the reset time, or with **Mark available**.

## Runtime needs setup

Besides usage limits, a runtime can be unusable because the CLI was never set up for this folder
(trust prompt, login), is missing from PATH, or stalls waiting for an interactive answer. The
harness treats this like a limit:

- detected from the CLI's error text, or when a run dies/stalls before producing any output;
- recorded in `.harness/runtime-health.json` with a hint; agents on that runtime are paused;
- the task goes back to `todo` without using an attempt (no more burning all attempts in a second);
- the dashboard offers **Test again** and **Switch**; a passing test (or any successful run) clears it.

Every switch to another runtime triggers a one-line test of that runtime. Turns are also stopped
after `loop.idle_timeout_s` without output and after `loop.turn_timeout_s` in total.

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
