---
name: writing-plans
description: Use when turning a feature, spec or multi-step change into an execution plan and board tasks — before any code is written. Produces small, ordered, verifiable tasks with exact files and checks.
---
# Writing plans

A good plan lets an implementer with no context start any task immediately.

## Steps
1. Read the spec, `ARCHITECTURE.md`, and the code you will touch. Note what already exists.
2. Write the plan (`docs/exec-plans/active/YYYY-MM-DD-<feature>.md`, from the template):
   - goal and **non-goals**;
   - approach in a few sentences, with the alternative you rejected and why;
   - files/modules to create or change, per step;
   - risks (data migration, platform differences, SDK limits) and how each is handled;
   - validation: which tests, commands, devices prove each step.
3. Split into tasks, each ≈ one reviewable change (< ~300 lines, one area):
   - title = verb + outcome ("Add streak counter to home screen");
   - 2–5 acceptance criteria that a test, command or screenshot can check;
   - dependencies (`--deps`) so they run in order; tests either inside the task or as a tester task.
4. Create them on the board and list the ids in the plan:
   `node harness/cli.mjs task add "<title>" --role implementer --plan <plan> --deps T-0xx --accept "a;b;c" --desc "<files, constraints>"`

## Order that usually works
data/model → repository/service → state → UI → wiring/navigation → tests/edge cases → docs.

## Keep it honest
Open questions go in the plan. If one blocks the work, block the planning task with the question
instead of guessing (see `clarifying-requirements`).
