# Evaluation wire-plan guard: local validation t001

Date: 2026-09-25. Scope: the account-free evaluation plan and the opt-in
provider-only run handoff for the shipped DeepSeek and Jev adapters. All
requests in this validation used synthetic datasets and injected offline
transport; no paid model request or host tool was made.

## Mismatch reproduced before the change

The route-declared plan already checked each complete locally serialized
request body, but its `routeGuardDigest` did not bind those bodies or
DeepSeek's output-token cap. A plan made with 64 output tokens could still
match an opted-in run using the default 512. Reordering fields inside a case
state kept the canonical dataset and route digests equal while changing the
actual JSON request body. Both are review-to-run drift, not provider failure.

## Change and boundary

- A route-declared plan now emits a separate `wireGuardDigest`. It binds its
  existing route guard, a provider serializer ID, the effective output-token
  limit (DeepSeek default 512 or explicit 1–4096; Jev `null`), and an ordered
  digest of **every capability-eligible** locally serialized request body.
  Each internal entry includes case ID, UTF-8 length, SHA-256 of the full
  body, wire-sendable status and request-cap selection. This covers cases
  rejected for body size and cases deferred by the request cap. The entries
  and raw bodies are not printed by the plan.
- `run --expect-wire-plan-digest` recomputes that digest before reading a key,
  constructing a provider or reserving an output file. It snapshots the
  declared provider/model/revision for construction and checks the resulting
  binding. A mismatch is a local `ContractError`: no provider call, output
  file or retry. The flag may be used alone or with the older plan/route
  guards; their formulas and narrower meanings are unchanged.
- The guard is an accident-prevention fingerprint for shipped adapters, not
  authenticated consent, endpoint/model identity, a price or monetary cap,
  or an assertion about arbitrary injected provider factories. The actual
  adapters still check final input and body limits before each request;
  post-invocation failures remain failures and stop the batch.

## Verification

- `npm ci --ignore-scripts`: pass, zero reported vulnerabilities.
- `npm run check`: 870 tests; 868 passed, zero failed, two local Windows
  symlink-privilege skips. TypeScript typecheck and build passed.
- `npm run demo`, `npm run demo:durable`, `npm run demo:recovery`,
  `npm run demo:comparison`, and `npm run first-run`: all passed with
  synthetic fixtures and no account.
- The new targeted tests first failed on missing guard/CLI flag, then passed.
  They verify default and explicit 512 equivalence, 64 mismatch, unchanged
  older digests, identical canonical dataset digest but changed wire digest
  after JSON field reordering, and changes in deferred and wire-rejected
  bodies. A separately calculated digest checks the complete DeepSeek/Jev
  request-body serialization formula.
- CLI tests verify changed cap/body/provider/model/revision reject before
  credential reads, provider construction and output reservation; a matching
  DeepSeek route makes one injected offline fetch and pins the changing model
  getter. Jev accepts the wire guard with both older guards and rejects a
  DeepSeek-only token option.

## Remaining acceptance

The local process had no `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` or
`REFLEXMESH_PROVIDER_REVISION` configured. A read-only doctor recognized the
installed DeepSeek Harness 0.1.2-rc.1 package but reported live loading
unverified; the default web profile did not mention ReflexMesh. No default
profile, real model, account billing, representative label quality or broad
host lifecycle acceptance is inferred from this local milestone. The full
product objective remains open.
