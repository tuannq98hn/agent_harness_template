# Architecture Rules

This file defines architecture constraints that should be enforced by review, tests, scripts, or CI when possible.

## General Rules

- Keep business/domain logic independent from UI and infrastructure.
- Keep platform-specific integrations behind adapters/services.
- Avoid circular dependencies.
- Avoid large files with mixed responsibilities.
- Public APIs/contracts should be documented.
- Data models should be explicit and versioned when needed.

## Import Boundary Rules

> Customize per project.

Example:

```txt
UI may import application/domain.
Application may import domain and infrastructure interfaces.
Domain must not import UI or infrastructure.
Infrastructure may import domain models/interfaces.
```

## Enforcement

Add project-specific checks to `scripts/ci/verify_architecture.sh`.
