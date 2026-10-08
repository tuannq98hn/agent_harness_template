# Agent-First Harness Template

Reusable repository harness for AI-agent-assisted development, with:

- **Multiple agents with roles** — orchestrator (manager), planner, implementers, tester,
  reviewer, docs gardener. Rules per role in `agents/`.
- **A work loop** — tasks are dispatched, verified by the quality gate and a reviewer agent,
  retried with feedback, or parked as `pending` for you.
- **A local dashboard** — live agent activity, task and issue boards
  (todo / in-progress / done / pending), activity log, and chat with any agent.
- **Per-agent runtime** — pick Claude Code or Codex (and a model) for each agent from the dashboard.
- **Usage-limit handling** — a limit pauses the agents on that runtime and requeues their tasks
  without using an attempt. Choose what happens next: wait and continue automatically when the limit
  resets (default), switch to the other runtime and back, or stop. **All agents on** switches every
  agent between Claude Code and Codex in one click.
- **Run / Stop / Retry** for a single task or issue, next to Start/Stop for the whole loop.
- **Bug flow** — every bug is first reproduced by the tester into `docs/bugs/<ISSUE>.md` (steps,
  environment, evidence, skipped failing test), then fixed by an implementer who starts from that report.
- **Time control** — stop the loop after N minutes, run it on a daily schedule (e.g. 22:00–06:00
  on weekdays), and stop silent or overlong agent turns.
- **Skills** — 11 portable how-tos (TDD, systematic debugging, verification before completion,
  writing plans, code review, repro reports, UI evidence, code search, …) in `.agents/skills/`,
  mirrored to `.claude/skills/`, recommended per role.
- **Model per agent** — pick Opus / Sonnet / Haiku (or any model id) for each agent, a whole role,
  or a single chat, from the dashboard.
- **finder** — a read-only search agent on a mid-size model; others `ask finder "where is …"` and
  get paths + line ranges instead of spending big-model tokens on searching.
- **Agent-to-agent asks across runtimes** — an orchestrator on Claude Code can call a Codex agent
  (or the reverse) and get the answer back in the same turn: `node harness/cli.mjs ask dev-1 "..."`.

Works with Claude Code, Codex CLI, or any CLI agent you configure. Zero npm dependencies;
needs Node.js 18+.

## Quick start

```bash
# 1. copy the template into your repo, then:
cat .gitignore.agent-harness-snippet >> .gitignore
node harness/cli.mjs init

# 2. try everything without spending tokens
#    (set "default_runtime": "mock" in harness.config.json first)
node harness/cli.mjs task add "Try the loop" --accept "it works"
./dashboard.sh                   # Windows: dashboard.cmd — opens http://127.0.0.1:4317
                                 # then press "Start loop"

# 3. switch "default_runtime" back to "claude" (or "codex") and give real work
```

Dashboard at a glance:

| Area | What you do there |
|---|---|
| Top bar | Start / stop the whole loop, open Settings (runtimes, parallel agents, attempts, gate) |
| Agents (left) | **All agents on** switches every agent's runtime; click an agent to change its runtime/model or watch its log |
| Needs you strip | Usage-limit warnings with "Switch to …", pending tasks with Retry |
| Board (center) | Tasks / Issues / Activity; ▶ Run, ■ Stop, ↻ Retry on each card; drag between columns |
| Chat (right) | Pick agent and runtime, switch between past chats, New, Save to `docs/chat-logs/` |

From then on, the usual flow is: open the dashboard → chat with `orchestrator` about what you
want → it creates tasks → press **Start loop** → answer anything that lands in **Pending**.

Command line equivalents:

```bash
node harness/cli.mjs help        # board commands (used by agents too)
node harness/loop.mjs            # run the loop in a terminal
node harness/loop.mjs --once     # dispatch one round only
touch .harness/STOP              # ask a running loop to stop
```

## Layout

```txt
AGENTS.md / CLAUDE.md        entry point for every agent (CLAUDE.md imports AGENTS.md)
ARCHITECTURE.md, docs/       project knowledge: specs, plans, ADRs, validation rules
agents/<role>.md             role rules (frontmatter compatible with Claude Code subagents)
harness.config.json          agent instances, runtimes (claude/codex/mock), loop limits
harness/cli.mjs              board CLI — the only way to change tasks/issues
harness/loop.mjs             dispatch → gate → review → done/retry/pending
harness/server.mjs           local dashboard server (127.0.0.1 only)
harness/dashboard/index.html dashboard UI (served by server.mjs, not opened as a file)
dashboard.sh / dashboard.cmd start the dashboard and open the browser
.harness/                    board state (tasks.json, issues.json) + runtime logs
scripts/agent, scripts/ci,   quality gate, architecture checks, test entrypoints
scripts/test
```

## Adapting to a project

1. Fill `ARCHITECTURE.md`, `docs/PRODUCT_SENSE.md`, `docs/SECURITY.md` for the real project.
2. Make `bash scripts/agent/run_quality_gate.sh` meaningful for your stack — the loop trusts it.
3. Add stack-specific boundary checks to `scripts/ci/verify_architecture.sh`.
4. Tune `harness.config.json`: which agents exist, which runtime/model each uses,
   `max_parallel`, `max_attempts`, `use_worktrees`.
5. Narrow each role's `tools:` in `agents/*.md` if you want stricter permissions.

## Skills

Skills follow the open Agent Skills format (`<name>/SKILL.md` with `name` + `description`), so the same
files work in both runtimes:

- **Edit and add skills in `.agents/skills/`** — Codex reads this folder natively.
- The harness copies them to `.claude/skills/` (Claude Code's folder) when the dashboard or loop starts,
  or with `node harness/cli.mjs skills sync`. Folders you create yourself in `.claude/skills/` are never touched.
- Each role lists its recommended skills in `agents/<role>.md` (`skills:`); they are named in the agent's prompt.

| Skill | Used by | What it enforces |
|---|---|---|
| `systematic-debugging` | implementer, tester | root cause with evidence before any fix |
| `test-driven-development` | implementer, tester | failing test first, red → green → refactor |
| `verification-before-completion` | implementer, tester, reviewer | run checks and quote evidence before "done" |
| `writing-plans` | planner, orchestrator | small ordered tasks with files and checks |
| `clarifying-requirements` | planner, orchestrator | find the real goal before planning |
| `reviewing-code` | reviewer | ordered checks, actionable feedback |
| `receiving-review-feedback` | implementer | verify feedback, fix or push back with evidence |
| `bug-repro-report` | tester | `docs/bugs/<ISSUE>.md` anyone can follow |
| `ui-evidence` | tester, implementer | screenshots/logs from Android, iOS, Flutter, web |
| `codebase-search` | finder, everyone | find code cheaply, answer with paths + lines |
| `writing-skills` | orchestrator, docs-gardener | turn a repeated procedure into a new skill |

These are written for this harness, following practices popularised by the community skill set
[obra/superpowers](https://github.com/obra/superpowers) and Anthropic's skill guidance. Add project-specific
skills (release build, adding a screen in your architecture, seeding test data) with `writing-skills`.

## Models

Click an agent → **Model**: choose from the runtime's list (`runtimes.<name>.models` in
`harness.config.json`) or **Custom…** for any id the CLI accepts. **Use for all <role> agents** applies it
to the whole role. The chat panel has its own Model picker per conversation.

Suggested starting point: orchestrator, planner, reviewer → strongest model; implementers → strong or
balanced; tester → balanced; finder, docs → smaller/cheaper. Smaller models on routine roles also make
usage limits arrive later. Codex lists only "Default" — type the model names your Codex version supports.

## First run of Claude Code / Codex in a project

Each CLI asks once per folder whether you trust it (and to log in). The harness runs them
without a terminal, so they can't ask. Before using a runtime in a new project:

```bash
cd my_project
claude      # accept the trust prompt, /login if needed, then exit
codex       # trust the folder, log in if needed, then exit
```

If you forget, the dashboard shows "**Codex cannot run in this project yet**" with these steps.
Agents on that runtime pause, their tasks go back to Todo **without using an attempt**, and
after you fix it you press **Test again** (or Settings → Test). A CLI that prints nothing for
`loop.idle_timeout_s` seconds (default 300) is stopped, so a hidden prompt can never hang the board.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Banner "cannot run in this project yet" | Run that CLI once in the project folder (see above), then Test again |
| Banner "hit its usage limit" | Default: nothing — the loop continues at the reset time. Or Switch / Check now |
| Start loop says "Nothing can start" | Every todo task waits on a pending task: answer it and Retry, or ▶ Run one task |
| Agents switched but nothing runs | Check the runtime tag in Settings: *works* / *needs setup* / *not found* |
| Dashboard not responding | Look at `.harness/dashboard.log`, then restart `./dashboard.sh` (board state is kept) |

## Runtime notes

- **Claude Code**: runs `claude -p ... --output-format stream-json` with `--permission-mode
  acceptEdits` and the role's `--allowedTools`. Chat keeps context via `--resume`.
- **Codex**: runs `codex exec --json --full-auto`. Chat context is replayed from history.
  Check the flags against your installed Codex version.
- **Asks from Codex to Claude**: Codex's sandbox may block network access for commands it runs.
  If `ask` from a Codex agent fails with a connection error, allow network access in Codex's
  sandbox settings for this project (or let a Claude Code agent be the orchestrator).
- Agents run unattended with shell access in this repo. Keep secrets out of the working
  tree, keep `max_iterations` modest, and review diffs before merging.

## Recommended first agent prompt

```txt
Read AGENTS.md, ARCHITECTURE.md, docs/validation/quality-gates.md and
docs/agent-workflows/multi-agent-loop.md. Inspect the repository and propose the minimal
project-specific updates needed to adapt this harness. Create them as tasks on the board
with the harness CLI. Do not implement application features yet.
```
