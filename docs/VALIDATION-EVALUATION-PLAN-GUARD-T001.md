# Offline evaluation plan guard validation t001

Date: 2026-09-25. Scope: a local candidate extending the account-free
[evaluation preflight](VALIDATION-EVALUATION-PLAN-T001.md) with an optional
paid-run mismatch guard. Remote review and CI need separate readback.

## Contract

The plan prints `guardDigest`, a SHA-256 of a versioned canonical envelope
containing the exact dataset digest, declared DeepSeek/Jev provider, request
cap and trusted provider-capability digest. A run with
`--expect-plan-digest` recomputes the value from its current dataset and
selected provider **before** constructing a provider, reading its key or
reserving the output file. A mismatch fails without a request or output
artifact. Existing runs without this optional guard remain compatible.

The digest is not a signature, user approval, secret or spending budget. It
does not bind the model ID/revision, account, prices, labels or actual HTTP
body. A matching guard does not authorize data egress and cannot prove model
quality. Explicit remote opt-in, account controls and dataset review still
apply. No automatic retry or model fallback is added.

## Local checks

- `npm ci --ignore-scripts`: passed with zero reported vulnerabilities.
- `npm run check`: **859 tests, 857 passed, zero failed, two local
  symlink-privilege skips**; typecheck and build passed.
- `npm run demo`, `npm run demo:durable`, `npm run demo:recovery` and
  `npm run demo:comparison`: passed.
- Focused tests cover malformed guard input, changed dataset content,
  changed provider route and changed request cap. Each mismatch was rejected
  before a credential-access trap, provider factory and output reservation.
- A matching guard reached the existing synthetic provider runner and
  produced one complete prediction receipt; unguarded existing CLI tests
  still passed.

No real key, account, user dataset, paid request or host tool was used.
