---
name: writing-skills
description: Use when a multi-step procedure keeps repeating in this project (release build, adding a screen, seeding test data) and should become a reusable skill — create or update a SKILL.md in .agents/skills.
---
# Writing skills for this project

A skill is a short, tested how-to that agents load only when needed. Add one when the same procedure
has been explained or rediscovered twice.

## Create
1. `mkdir -p .agents/skills/<kebab-name>` and write `SKILL.md`:
   ```
   ---
   name: <kebab-name>
   description: Use when <trigger situations, words people use> — <what it produces>.
   ---
   # Title
   <steps with exact commands for THIS repo, expected output, common failures and fixes>
   ```
   Only `name` and `description` in the frontmatter, so it works in both Claude Code and Codex.
2. Put the trigger words first in `description` — descriptions get shortened when there are many skills.
3. Keep the body under ~150 lines; move long references into files next to it (`reference.md`, `scripts/`).
4. Test it: follow it yourself from a clean state; fix every step that needed guessing.
5. Map it to roles: add the name to `skills:` in the matching `agents/<role>.md`.
6. Run `node harness/cli.mjs skills sync` (copies to `.claude/skills/` for Claude Code).

## Don't
Write general knowledge the model already has, duplicate role rules, or keep a skill that is out of date —
fix or delete it.
