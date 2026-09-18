# Coding-agent instructions

Read README.md, SECURITY.md and docs/ARCHITECTURE.md before editing.

## Required checks

```bash
npm ci --ignore-scripts
npm run check
npm run demo
```

Tests and the default demo must work without keys or external services. Never claim a real Jev smoke test passed unless it actually ran against an authorized account; do not print its key, request state or response body in logs.

## Invariants

- Preserve default shadow mode and deny-by-default host authorization.
- Model confidence cannot override deterministic security policy.
- Validate input/output at runtime, not just through TypeScript.
- Register capabilities in trusted code; do not accept them from event payloads.
- Never call tools during policy replay/calibration. Do not turn labeled mock data into performance claims.
- Do not replace unknown execution outcomes with retries or pretend a compensation is ACID rollback.
- Persisted audit != persisted idempotency. Add crash/restart tests before claiming durability.
- Keep provider/model/pack versions explicit. Changing a provider does not preserve score calibration automatically.
- Store no user tokens, real personal data, traces or production logs in the repository.
- Prefer small reviewed changes; follow docs/ROADMAP.md milestone order.

## Initial delivery state

The scaffold was tested in a local container and published to `luomo66ccff/reflexmesh`. GitHub Actions results must still be checked before claiming remote CI has passed. The publication helper is retained for forks/renamed deployments and refuses to overwrite an existing repository.
