# Installed Claude / synthetic local Messages validation

Date: 2026-09-22 (Asia/Shanghai). Branch: `feat/claude-local-loop`, based on
`2e59f2d7c443e38d6eeb000c1ec6c9302d3676c8` / [PR #10](https://github.com/luomo66ccff/reflexmesh/pull/10),
not merged main. This report records local validation of this increment;
remote CI must be checked against the newly published exact head separately.
Earlier reports are unchanged historical evidence.

## Verified results

| Check | Actual result |
| --- | --- |
| `npm ci --ignore-scripts`, build and typecheck | Passed |
| Windows / Node 24.19.0 `npm run check` | 354 tests: 353 passed, 0 failed, 1 expected symlink skip |
| Windows / portable Node 22.23.2 typecheck and full sequential test suite | 354 tests: 353 passed, 0 failed, 1 expected symlink skip |
| Four offline demos: default, durable, recovery, evidence | Passed on Node 24 |
| Installed native Claude Code 2.1.263, hook processes on Node 24.19.0 | `single-read` 22/22; `duplicate-pre` 22/22 |
| Same installed CLI, hook processes on Node 22.23.2 | `single-read` 22/22; `duplicate-pre` 22/22 |
| CLI help, fixed failure output, diff whitespace | Passed |

Reproduce the installed check with `npm run compat:claude-local`; see the
[guide](CLAUDE-LOCAL-LOOP.md) for pinned support, prerequisites and refusal modes.
The native CLI, its Read and hook processes are real. Model responses are
synthetic and local; no real model inference, real account, default profile,
new decision provider or paid API call is part of this increment.

For each actual scenario, the fixture observed exactly one `HEAD /api/hello`,
two Messages requests and zero token-count requests, with no unexpected request.
The second request contained the random file proof, which was absent from the
prompt and synthetic tool call. Only Read was offered and executed. Both final
results succeeded, and the fixture file was unchanged.

The gate checks one prompt/pre/post/Stop lifecycle in the same session/root
agent; matching host-stream hook responses and invocation ID; schema 3 and one
exact ledger key; the task summary/scope, action and result digests; completed
shadow/abstain deployment binding; zero labels; and cache emptiness immediately
after Stop rather than after later session disposal. Raw summary, file proof
and dummy credential are absent from inspected ledger evidence.

Normal pairing is `ready` with one harness-reported success. The second fresh
scenario injects two deliveries to the real observer during one native pre-hook:
pairing becomes `blocked / duplicate_pre`, the outcome is not admitted, and
native Read still succeeds. All adapter responses abstain. This is deliberate
observer fault injection, not a naturally observed Claude duplicate execution.
The wrapper adds fixture guarding and receipt capture; arbitrary direct-hook
installation configurations are not certified.

## Failures found and fixed before final validation

- The initial strict fixture rejected the actual version-specific hello
  handshake. It now accepts that exact body-free route once; route/body/auth and
  request-limit negative tests remain. This is observed behavior, not a public
  API compatibility guarantee.
- `--bare` plus explicit settings yielded a successful Read but no hook/ledger
  evidence on this executable. The verifier rejected it. The final command uses
  non-bare restricted mode, separate configuration stores and conservative
  ancestor/managed-policy gates. It never edits existing policy or user context.
- An unrecognized synthetic model label changed the CLI message shape and
  failed the strict exchange. The final fixture uses `claude-sonnet-4-6` solely
  as a recognized wire label, not a real inference endpoint. The fixture was
  not loosened to accept arbitrary message shapes.
- Independent read-only review reproduced false passes for foreign lifecycle
  sessions, wrong stdout invocation IDs, StopFailure and early SessionEnd. The
  gate now rejects those cases, mismatched/failed host hook responses and corrupt
  JSONL. Root verified the fixed negative cases and actual-host positive controls.
- Review also reproduced acceptance of extra tools, an altered echoed Read path
  and proof hidden in non-text metadata. The service now requires exact one-Read
  declarations and echoed invocation/path, and proof within text results only.
  Independent review reran the 28 service tests and found no remaining blocker
  in the scoped changes. This is not a full security audit.

The increment adds **66 offline tests**: 28 localhost service tests, 35 probe
environment/gate/verifier/cleanup tests and 3 separate-process wrapper tests.
Tests cover refusal with zero session starts, host timeout/output-limit/spawn
failure cleanup, malformed receipts, preservation of unrelated files, closed
listeners and fixed cleanup errors. These tests need no installed Claude or
credentials and run in normal CI. Installed CLI probes remain opt-in.

## Evidence limits

No production adapter/kernel/schema or permission behavior changed in this
increment. Existing DeepSeek probes were not mechanically rerun; their dated
evidence remains separate. The current default full suite includes those modules'
offline regressions.

No default-profile, real-model Claude, parallel-tool, subagent, cancellation,
resume/restart, managed deployment or other CLI-version/platform certification
is claimed. CLI isolation is not an OS sandbox or a network-egress audit.
Forced Windows descendant termination remains best-effort. Temporary cleanup
passed on these completed runs; a failure is reported rather than hidden.
Production privacy/load/retention and full host lifecycle acceptance remain
open in [iteration state](ITERATION-STATE.md).
