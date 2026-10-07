# ARCHITECTURE.md

This document describes the system architecture at a level that helps humans and AI agents make safe changes.

## Architecture Summary

> Replace this section with the project-specific architecture summary.

Example format:

- Product type: mobile app / web app / backend service / desktop app / monorepo
- Main platforms: Android / iOS / Web / API / Worker / CLI
- Primary language/framework: Flutter / Kotlin / Swift / Next.js / Node.js / Python / etc.
- Data storage: local DB / server DB / cache / object storage
- External services: auth, analytics, payment, ads, AI providers, push notification, etc.

## System Boundaries

Define the major modules and their responsibilities.

| Boundary | Responsibility | Must Not Do |
|---|---|---|
| UI / Presentation | Render screens and collect user intent | Call low-level infrastructure directly |
| Application / Use Case | Coordinate user actions and business flows | Own persistence details |
| Domain / Model | Represent business rules and core entities | Depend on UI or infrastructure |
| Infrastructure / Data | API, database, filesystem, SDK integrations | Leak SDK-specific logic upward |

## Dependency Direction

Default rule:

```txt
UI -> Application -> Domain
Infrastructure -> Domain
Application -> Infrastructure via interfaces/adapters
```

Adjust this section to match the project stack.

## Data Flow

Describe normal request/data flow here.

Example:

```txt
User Action -> View/Screen -> Controller/ViewModel/Bloc -> Use Case/Service -> Repository -> API/DB -> Model -> UI State
```

## Error Handling Policy

- Convert low-level errors into meaningful application errors.
- Do not expose raw secrets, tokens, stack traces, or provider-specific errors to end users.
- Log enough context for debugging without leaking sensitive data.
- Prefer explicit error states over silent failure.

## Configuration Policy

- Runtime configuration should be centralized.
- Secrets must come from environment variables, secret managers, or platform-specific secure storage.
- Do not hardcode production secrets.
- Document all required environment variables in `docs/references/env-reference.md` or the project README.

## Architecture Change Policy

When making architecture-level changes:

1. Add or update an ADR under `docs/decisions/`.
2. Update this file.
3. Update validation rules if needed.
4. Run the full quality gate.
