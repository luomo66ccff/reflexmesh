# Declared evaluation route plan validation t001

Date: 2026-09-25. Scope: a local candidate extending the optional
[account-free evaluation preflight](VALIDATION-EVALUATION-PLAN-T001.md)
and [plan guard](VALIDATION-EVALUATION-PLAN-GUARD-T001.md) with a
declared model-route mismatch check. Remote review and CI need a
separate readback.

## Contract

`evaluation plan --model-id ID --provider-revision REV` requires both
non-secret declarations and prints `routeGuardDigest`. Its versioned
canonical digest binds the existing dataset/provider/request-cap/trusted
capability guard plus trusted provider ID, declared model ID and revision.
`evaluation run --expect-route-plan-digest` checks the current selected
provider/model/revision before credential access, provider construction
or output reservation. The checked route is held stable across the
dynamic import and provider construction; the constructed provider and
binding must still match it before output is opened. Existing unbound
`--expect-plan-digest` and unguarded runs remain compatible.

The digest is not a signature, permission, account identity, actual model
weight verification or spending budget. It does not bind actual wire
bytes, output tokens, timeout, labels or remote pricing. An account/model
alias may retarget without the declared strings changing. Explicit
remote opt-in, minimized dataset review and account controls still apply.
No retry, fallback, host action or model promotion was added.

## Local checks

- `npm ci --ignore-scripts`: passed with zero reported vulnerabilities.
- `npm run check`: **862 tests, 860 passed, zero failed, two local
  symlink-privilege skips**; typecheck and build passed.
- `npm run demo`, `npm run demo:comparison`, `npm run demo:durable`
  and `npm run demo:recovery`: passed.
- Focused evaluation tests: **23/23 passed** after the final test
  refinement. They cover malformed/partial route input, digest changes
  for model and revision, dataset/provider/cap drift, rejection before
  credential traps/provider factory/output reservation, stable checked
  route through construction, mismatched constructed binding, and one
  offline synthetic DeepSeek adapter transport plus a matching Jev
  declaration.
- `npm run evaluation -- --help`: passed through the standalone npm CLI.
  A separate temporary-file manual plan walk-through was not executed
  because the local shell policy rejected its cleanup command before
  process start; it produced no fixture or acceptance evidence.

This process had no `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` or
`REFLEXMESH_PROVIDER_REVISION`; no real account, paid request, user
dataset, label or host tool was used. Model quality and broad host
lifecycle acceptance remain open.
