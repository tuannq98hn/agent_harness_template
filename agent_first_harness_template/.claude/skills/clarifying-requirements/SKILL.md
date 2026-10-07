---
name: clarifying-requirements
description: Use when a request is vague, large or new (a feature idea, "make it better", a redesign) before planning or building — find the real goal, constraints and success criteria, then propose options.
---
# Clarifying requirements

Building the wrong thing well is still waste. Before planning:

1. **Restate** the request in one sentence: who it is for, what they can do afterwards.
2. **Find the gaps** — check each and note what is unknown:
   - user and situation (first-time user? offline? one-handed on a phone?);
   - success criteria (what would make this "done" and "good"?);
   - scope edges (platforms, languages, accounts, existing data/migration);
   - constraints (deadline, SDKs, store policy, performance, cost);
   - what must NOT change.
3. **Look before asking**: specs, design docs, existing screens/code often answer it.
4. **Ask only what blocks you** — at most 3 concrete questions, each with a suggested default
   ("I'll assume Android + iOS only, not web — OK?").
5. **Offer 2–3 options** when there is a real choice, with trade-offs in one line each, and recommend one.
6. Write the agreed answers into the spec so nobody has to ask again.

In this harness: questions to the human go through `task block <ID> --reason "..."` (loop) or
directly in chat (orchestrator).
