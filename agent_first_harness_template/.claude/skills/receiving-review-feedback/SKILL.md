---
name: receiving-review-feedback
description: Use when a task comes back with reviewer feedback, a rejected review, or quality-gate failures to fix — evaluate each point technically, fix what is right, and push back with evidence on what is wrong.
---
# Receiving review feedback

Feedback is input, not orders. Agreeing with a wrong comment is as bad as ignoring a right one.

1. **Read all points first.** Group them: blocking, nit, question.
2. **Verify each point** against the code and spec before changing anything:
   - reproduce the problem the reviewer describes (run the test, follow the path);
   - if the point is correct → fix it and add/adjust a test that would have caught it;
   - if it is wrong or would break something → don't change the code; explain why in a task note
     with evidence (file:line, test output, spec section).
   - unclear → `task block` with the specific question rather than guessing.
3. **Fix in priority order**, re-running narrow checks after each.
4. **Answer every point** in one task note: `1) fixed in x.dart:42 + test` · `2) not changed: spec §3 requires …`.
5. Run the full checks (`verification-before-completion`) and resubmit.

Avoid: "Great catch!" without a change, silently skipping points, or rewriting unrelated code to look busy.
