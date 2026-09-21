# Independent decision provider validation t001

Date: 2026-09-22 (Asia/Shanghai). Branch: `feat/independent-provider`, based on
PR #14's `ed8754d`, not merged main. This report is a bounded engineering
receipt, not a calibration, production-support or bug-free certificate.

## What changed

- Required, strict, deeply frozen provider declarations describe answer types,
  limits and numeric provenance. Jev is `provider-native`, the independent
  DeepSeek adapter is `elicited-estimate`, Mock is `synthetic-fixture`, and
  abstention is `none`. None implies measured calibration.
- Final input gates run before evaluation/HTTP. Unsupported types, size/count
  limits and cancellation fail closed. Shared conformance exercises both
  transports without disguising their different supported types.
- Validated capability digests join deployment and idempotency identity before
  Claude pairing is derived. Explicit model mismatches fail construction;
  response model mismatches reject assessment. Task-aware/durable wrappers
  preserve the binding. Historical missing fields remain null, not backfilled.
- The new DeepSeek provider uses its own credential, fixed official endpoint,
  prompt and JSON parser, without Jev transport or fabricated numeric answers.
  Binary estimates only; no choice/score conversion, retries or provider fallback.
- The paid synthetic demo is explicit opt-in, separately bounded to one request,
  512 output tokens and 8000 request bytes. Default demos/checks remain offline.

## Review corrections and local checks

Independent review reproduced three serialization variants of one input-gate
defect: a nested question `toJSON` changed a validated binary question into a
choice on the wire, and an array `toJSON` expanded state beyond its declared
byte limit. Non-enumerable question fields could also pass validation but
vanish on the wire. Strict JSON checks now reject hidden object fields,
question hooks and non-plain/extended arrays, including indexed accessors,
without invoking them. Root verified the
same direct-provider regressions against Jev and DeepSeek; scoped independent
re-review passed the shared conformance suite (40/40) with no remaining blocker
in that reviewed scope.

An initial full suite also encountered Node Fetch's `bad port` error in a
synthetic Claude fixture. The exact randomly bound port was not captured.
The three fixture servers now bind only loopback addresses in the high private
port range, with bounded collision retries; this avoids the
[Fetch Standard's blocked-port set](https://fetch.spec.whatwg.org/#bad-port).
Tests cover a real local fetch, collision exhaustion and non-collision errors.
No production network endpoint or retry behavior changed.

On Windows:

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed |
| Node 24.19.0 `npm run check` | 635 tests; 634 passed, 0 failed, 1 expected symlink skip |
| Node 22.23.2 full offline tests | 635 tests; 634 passed, 0 failed, 1 expected symlink skip |
| Four existing offline demos | Passed |
| `npm run demo:deepseek -- --help` | Passed; no credential read or request |
| Installed Claude 2.1.263 generated setup, Node 22/24 | 17/17 each capture-off and explicit-summary scenario |
| Installed Claude 2.1.263 cold resume, Node 22/24 | 20/20 each clean-exit and entered-then-killed scenario |

The Claude probes used isolated synthetic localhost transport and direct
production hook entrypoints, not a real Claude account/model/default profile.
They retest capability-binding propagation, not the full host matrix.

## Authorized real DeepSeek decision-provider smoke

One bounded official-API request ran at `2026-09-21T19:23:40Z` on Node 24.19.0
against the current implementation worktree. It used explicitly authorized
local credentials through a pure parser, without loading or modifying a host
profile. Only the shipped example's fixed synthetic task/tool description was
sent. No key, raw task, API response body or real user data is in this report.

- Requested and returned model: `deepseek-flash`; HTTP 200.
- Provider: `deepseek/binary-json-estimate-v1`, independent of Jev.
- Token usage returned by the API: 318 input, 35 output.
- All 11 assertions passed: exact binary answer set; explicit model and
  estimate semantics; durable capability digest and public projection;
  close/reopen same-identity replay; unsupported choice refused without another
  request; non-executing policy replay; zero tools, observations and labels;
  bounded usage; no raw synthetic task/arguments in the ledger.
- The shadow verdict was `allow`; this did not grant permission, execute a
  tool, supply a truth label or establish that the estimate was correct.
- Estimated peak token charge: US$0.0001374, using published peak cache-miss
  input/output rates of US$0.30/US$1.20 per million tokens, checked on the local
  test date. This is an estimate, not an invoice. See
  [official pricing](https://api-docs.deepseek.com/quick_start/pricing/).

The first receipt was deliberately taken from an uncommitted implementation,
not misrepresented as exact-head CI. The published PR's root verification
comment records any clean exact-head follow-up and exact-head CI separately.
The shared fixture tests never claim real inference. This is a **decision
provider** smoke, unlike the earlier
[host-model transport report](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md), where
ReflexMesh itself abstained.

## Reproduce and limits

Follow [DEEPSEEK-PROVIDER.md](DEEPSEEK-PROVIDER.md); use a private server-side
environment, explicit remote approval, model and separately named revision.
`npm run demo:deepseek` only prints help. Add `-- --execute` only when the
one-request synthetic data transfer and possible cost are authorized.

The production boundary still has a 3-second assessment deadline, while this
isolated demo uses 15 seconds. The single successful example is not evidence
of a host-latency SLO. The API route is an alias, not an immutable weight pin;
an unchanged response identifier cannot prove unchanged backend behavior.
The official [API](https://api-docs.deepseek.com/api/create-chat-completion/)
and [JSON-mode guide](https://api-docs.deepseek.com/guides/json_mode/) informed
the wire contract. Empty/malformed/truncated output is rejected, not repaired.

Still unverified: decision accuracy/calibration, independently labeled paired
comparisons, real Jev inference in this increment, model migration, high-load
privacy/retention, default host profiles, broad cancellation/subagent/restart
matrices and general platform support. No old labels, thresholds, outcomes or
schema-3 history are silently migrated. There is no automatic tool retry,
provider fallback, relaxed host authorization or automatic PR merge.
