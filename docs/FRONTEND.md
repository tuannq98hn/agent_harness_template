# FRONTEND.md

This document defines frontend implementation guidance for web, mobile, and desktop clients.

## UI Layer Rules

- UI should render state and emit user intent.
- UI should not own business logic that belongs in application/domain layers.
- UI should not directly call APIs, databases, SDKs, or low-level services unless explicitly approved by architecture.
- Complex widgets/components should be decomposed into smaller reusable units.

## State Management

> Replace with project-specific state management rules.

Recommended content:

- State container choice
- Async loading/error/success conventions
- Caching behavior
- Navigation flow ownership
- Form validation ownership

## Testing Expectations

- Test reusable presentation logic.
- Test critical user flows.
- Add snapshot/visual checks if the project supports them.
- Document manual UI verification when automated tests are not yet available.
