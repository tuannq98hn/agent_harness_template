# Quality Gates

A change is complete only when the relevant gates pass.

## Default Gate

Run:

```bash
bash scripts/agent/run_quality_gate.sh
```

## Gate Categories

| Gate | Required When | Examples |
|---|---|---|
| Format | Any code change | formatter, import sort |
| Static analysis | Any code change | lint, type check, analyze |
| Unit tests | Logic changes | domain/use case/service tests |
| Integration tests | Multi-module or API changes | API/db/client integration |
| UI tests | UI or flow changes | widget/e2e/snapshot/manual |
| Security review | Auth/payment/secrets/network changes | secret scan, auth checks |
| Docs update | Behavior, architecture, config changes | spec, ADR, env reference |

## Allowed Exceptions

If a gate cannot run, document:

- Which gate was skipped
- Why it was skipped
- Risk level
- Manual verification performed
- Follow-up task or tech debt ID
