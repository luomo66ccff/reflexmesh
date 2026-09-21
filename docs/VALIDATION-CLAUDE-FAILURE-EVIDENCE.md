# Claude interruption semantics and mixed-outcome host validation

Date: 2026-09-22 (Asia/Shanghai). Branch: `fix/claude-interrupted-outcomes`,
based on `967e714356e0e9f7b18b878c09d9583a4b5d1496` /
[PR #12](https://github.com/luomo66ccff/reflexmesh/pull/12), not merged main.
Local evidence below is separate from newly published exact-head remote CI.
Earlier validation reports remain dated evidence.

## Verified results

| Check | Actual result |
| --- | --- |
| `npm ci --ignore-scripts`, build/typecheck | Passed |
| Windows / Node 24.19.0 full `npm run check` | 482 tests: 481 passed, zero failed, one expected symlink skip |
| Windows / portable Node 22.23.2 typecheck and full sequential suite | 482 tests: 481 passed, zero failed, one expected symlink skip |
| New normalization/process regressions | 11/11 on both Node versions |
| New transport/MCP/verifier regressions | 65/65; included in the full suites |
| Four offline demos: default, durable, recovery, evidence | Passed on Node 24 |
| Actual installed Claude Code 2.1.263, direct hooks and synthetic MCP, Node 24.19.0 | 19/19 |
| Same installed host and generated hooks, Node 22.23.2 | 19/19 |
| Previous installed generated-setup regression, Node 24 | Capture-off 17/17; explicit-summary 17/17 |
| Actual omitted-settings negative control | Native mixed outcomes completed, but required hook/ledger assertions failed |

The actual host starts with separate configuration stores, an empty inherited
ReflexMesh deployment environment, unchanged doctor-generated env/hooks, no
built-in tools and one explicit local MCP server. Its two fixed in-memory
calls return success and an MCP error respectively. A body-entry barrier
recorded both calls entering before either exited: this is observed overlap,
not an inference from two requested calls. Their IDs, action and selected task
digests, ready pairs and result-content digests match their respective ledger
rows. One observed result is succeeded and one failed, both harness-reported,
with zero labels. Both shadow decisions are completed.

Transport observed exactly one hello and two Messages requests, no unknown
route or extra request. There is no upstream connection or real model inference
in this fixture. Random synthetic success/failure values and the selected task
text are absent from inspected ledger records. Cache emptiness is checked at
exit, not attributed exclusively to Stop.

## Reproduced defect and correction

Root reproduced that `PostToolUseFailure` with `is_interrupt: true` became
ordinary `failed`; even a string `"true"` was silently treated as failure.
The failure hook's documented optional boolean now maps `true` to a reported
`unknown`, while absent/false stays `failed`. Invalid types are rejected.
Successful events with unexpected top-level failure-only fields are rejected.

Both hook entrypoints were exercised through separate actual Node processes
with source-shaped input: before/failure pairing, ordinary and interrupted
outcomes, malformed flags, conflicting second reports, exact error digests,
provenance, zero labels, evidence output and doctor warnings. A late interrupted
old call retains its original task and leaves the newly selected summary
available for a new call. Source-shaped interruption is **not actual Claude
cancellation evidence**.

No schema or historical observation is rewritten. A retained schema-2 failure
survives a writable migration unchanged and without a certified pair. Completed
shadow decisions do not become execution UNKNOWN, and observation uncertainty
does not create a recovery/retry permission. The raw error evidence digest path
is unchanged. Stop/StopFailure/SessionEnd cleanup and host permissions remain
unchanged.

## Verifier checks and failure controls

The actual ordinary MCP error fired `PostToolUseFailure`. Its hook error digest
matches the native `tool_result.content` string, not the separately formatted
typed display value, which adds `Error: `. Success uses its native content
array. Root verified both comparisons before adding the per-call gate.

The 19 checks require direct production configuration, one exact successful
session and two native calls/results, six matching successful hook invocations,
prompt/pre/post/Stop ordering, actual body overlap, exact local transport, two
ledger keys and ready schema-3 pairs, shadow/abstain/task bindings, independent
action/result digest matches, zero labels, an empty cache and minimized ledger.

Negative tests reject swapped outcomes, wrong task/call/session/digests,
malformed streams, fake error flags, missing/failed/misordered hooks, blocked
pairs, extra calls or transport, no overlap, raw content, stale cache and labels.
Transport tests reject wrong roles/order/model/tool sets, metadata-only proof,
unauthenticated/unknown/oversized requests and retries after a failed exchange.
MCP duplicate/unknown calls, invalid arguments and a one-body timeout cannot
claim overlap. Extra rejected MCP activity leaves a failing receipt.

Root also omitted the generated settings in an actual installed-host control.
The same two native tool outcomes and local Messages exchange succeeded, but
hook/ledger/task assertions failed as required. Mocked host timeout/output-limit,
doctor/policy refusal and cleanup-failure tests retain failure, close the local
listener and preserve an unrelated canary. Only the exact known Node SQLite
experimental warning is allowed alongside otherwise successful hook output.

Independent read-only review found no remaining P1/P2 blocker within the scoped
production change and new probe. Root ran the actual host checks and suites;
review itself did not start a host or modify files.

## Reproduction and exclusions

See [usage and semantics](CLAUDE-FAILURE-EVIDENCE.md). Offline CI never requires
credentials or silently starts an installed Claude. The separately opted-in
installed test is pinned to Windows Claude Code 2.1.263, with synthetic local
transport. No paid API calls, real account, default profile, user settings edit
or independent decision provider is part of this increment.

Real cancellation delivery, missing-hook cancellation outcomes, restart,
subagents, full task-replacement/default-profile compatibility, other platforms
and host versions, OS isolation, total egress or descendant-termination proof,
production load/privacy and all possible bugs remain unverified. A reported
failure is not proof of zero side effects. No automatic retry or truth label is
derived from either success, failure or interruption.
