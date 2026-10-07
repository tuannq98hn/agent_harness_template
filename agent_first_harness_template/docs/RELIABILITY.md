# RELIABILITY.md

This document defines reliability expectations.

## Reliability Principles

- Fail safely.
- Make errors observable.
- Avoid silent data loss.
- Prefer idempotent operations where possible.
- Handle offline, retry, timeout, and partial failure scenarios explicitly.

## Required Reliability Checks

- Critical flows have tests or manual verification notes.
- Network calls have timeout/error behavior.
- Background jobs are observable and recoverable.
- Data migrations have rollback or recovery notes.
- User-facing errors are understandable.

## Incident Notes

Add incident summaries and follow-up actions here.
