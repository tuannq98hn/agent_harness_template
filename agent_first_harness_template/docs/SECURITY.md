# SECURITY.md

This document defines baseline security rules for this repository.

## Security Rules

- Never commit secrets, tokens, private keys, certificates, or production credentials.
- Use environment variables or secret managers for sensitive configuration.
- Validate input at trust boundaries.
- Do not log secrets, access tokens, refresh tokens, passwords, or payment data.
- Apply least privilege to API keys, service accounts, database users, and CI tokens.
- Keep dependencies updated and remove unused packages.

## Authentication and Authorization

> Document project-specific auth rules here.

Include:

- Supported login methods
- Token/session behavior
- Role/permission model
- Admin access restrictions
- Logout/session invalidation behavior

## Security Review Checklist

- [ ] No secrets committed
- [ ] Input validation added where needed
- [ ] Authorization checked server-side
- [ ] Sensitive logs avoided
- [ ] Error messages do not leak internals
- [ ] Dependency changes reviewed
