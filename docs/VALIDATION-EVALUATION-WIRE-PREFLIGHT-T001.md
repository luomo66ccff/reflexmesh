# Evaluation request-body preflight: local validation t001

Date: 2026-09-25. Scope: the account-free evaluation plan, the bounded
provider-only runner, and the shipped DeepSeek and Jev HTTP adapters. All
transport checks below used synthetic datasets and injected offline fetch;
no paid model request or host tool was made.

## Defect reproduced before the change

A valid four-case dataset with a 33,000-character binary question passed
DeepSeek's declared state/question capability gate. The old plan reported
four eligible cases and up to one request, while the adapter rejected the
complete request body above 32,000 UTF-8 bytes before fetch. The runner
reported `failed/provider_error`, stopped later cases, and made zero fetches.
The same divergence occurred for Jev with a 260,000-character question and
its 256,000-byte body limit. This is a local compatibility mismatch, not a
remote provider failure.

## Change and trust boundary

- Each shipped adapter now owns one pure serializer used by both its live
  request and the account-free route-declared plan. Its exact complete body
  is checked, including DeepSeek's system message, nested JSON escaping,
  model, and output-token setting.
- A provider-construction-time preflight is captured by `snapshotProvider`.
  The evaluation runner checks it before incrementing its request count.
  Known local body-size rejection becomes `unsupported/input_incompatible`,
  so a later sendable case can use the same request slot. Generic provider
  callbacks and lookalike provider IDs are not treated as shipped preflights.
  Failures after entering `evaluate` still stop the batch without retry.
- An undeclared-route plan explicitly says the body was not checked. A
  declared-route plan adds separate wire-aware counts and selected body
  bytes while leaving capability counts, capability digest, `guardDigest`
  and `routeGuardDigest` formulas unchanged. DeepSeek defaults to 512 output
  tokens or accepts an explicit plan cap; Jev has no token-cap option.
  Existing guards do **not** bind output tokens or serializer version. The
  run rechecks the actual provider configuration before every request.

## Verification

- `npm ci --ignore-scripts`: pass; npm reported zero vulnerabilities.
- `npm run check`: 867 tests, 865 passed, zero failed, two local Windows
  symlink-privilege skips; TypeScript typecheck and build passed.
- Focused provider, runner, plan/CLI and capability tests: 81 passed before
  the final all-oversized extension; the runner test then passed again with
  both mixed and all-rejected batches.
- `npm run demo`, `npm run demo:comparison`, `npm run demo:durable`, and
  `npm run demo:recovery`: all passed with synthetic fixtures.
- Exact-limit tests captured the sent DeepSeek/Jev bodies at 32,000/256,000
  UTF-8 bytes, verified one byte beyond rejects with zero extra fetches,
  and checked UTF-8, quotes and backslashes against the shared serializer.
  Runner tests verified first-rejected/second-success with one fetch, and
  all-rejected with no fetch. Plan tests verified no-route honesty, both
  route checks, no raw state disclosure, and unchanged older guard digests.

## Not claimed

This is a local serialization and request-budget fix, not proof of endpoint
availability, actual billed bytes, model identity/quality, monetary cost,
human-reviewed outbound data, or broader host lifecycle acceptance.
Neither a green suite nor a synthetic response establishes those claims.
