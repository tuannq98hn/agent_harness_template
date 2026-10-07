# Feature Implementation Loop

Use this workflow for new features and planned changes.

## Loop

1. Read `AGENTS.md`.
2. Read architecture and relevant specs.
3. Create or update an execution plan.
4. Identify files likely to change.
5. Implement the smallest coherent change.
6. Run relevant checks frequently.
7. Update tests or add manual verification notes.
8. Update docs/status files.
9. Run `bash scripts/agent/run_quality_gate.sh` before completion.
10. Summarize changes, validation, and risks.

## Agent Constraints

- Do not expand scope without documenting it.
- Do not skip verification silently.
- Do not leave TODO comments without adding tech debt or follow-up plan.
- Do not rewrite unrelated code for style preference only.
