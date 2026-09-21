# Claude first-run diagnosis and generated-settings validation

Date: 2026-09-22 (Asia/Shanghai). Branch: `feat/claude-first-run`, based on
`36b73200368e81f0fcd2563d1c5687d23435a0fd` /
[PR #11](https://github.com/luomo66ccff/reflexmesh/pull/11), not merged main.
This report records local evidence; remote CI must be checked against this
increment's published exact head separately. Earlier reports remain unchanged.

## Verified results

| Check | Actual result |
| --- | --- |
| `npm ci --ignore-scripts`, build and typecheck | Passed |
| Windows / Node 24.19.0 `npm run check` | 406 tests: 405 passed, 0 failed, 1 expected symlink skip |
| Windows / portable Node 22.23.2 typecheck and full sequential test suite | 406 tests: 405 passed, 0 failed, 1 expected symlink skip |
| New setup/doctor/probe tests | 52/52 passed; previous 13 DeepSeek doctor tests also passed |
| Four offline demos: default, durable, recovery, evidence | Passed on Node 24 |
| Installed native Claude Code 2.1.263, generated hooks on Node 24.19.0 | Default capture-off 17/17; explicit-summary 17/17 |
| Same installed CLI, generated hooks on Node 22.23.2 | Default capture-off 17/17; explicit-summary 17/17 |
| Existing wrapper-based installed local-loop regression | Single-read 22/22; duplicate-pre 22/22 |
| Actual static doctor on an explicit executable with a missing ledger | Ready prerequisites, version/live host still unverified, capture off, seven hooks, no database created |
| CLI help, fixed failure output, documentation link and whitespace checks | Passed |

The final full suites and generated-settings host checks were rerun after all
production-path corrections below. Independent read-only review verified the
fixes and found no remaining blocker within this increment's scope.

## What is tested

`doctor:claude` takes explicit paths and namespace, reports prerequisites and
optional bounded historical evidence, and proposes seven direct production
hooks. It never starts Claude or a model, discovers credentials/profiles,
installs settings, creates a ledger or migrates an old one. Capture defaults off.
Executable presence is deliberately not a version, integrity or live-host
certificate. The prior DeepSeek doctor contract is unchanged; only its bounded
historical projection is exported for reuse.

`compat:claude-setup` is separate and opt-in. It starts the installed native
Windows Claude Code 2.1.263 and uses the doctor's generated `env` and `hooks`
unchanged, adding only two test-session isolation settings. It calls production
`claude-task-hook.mjs` directly, without the prior probe's wrapper. All inherited
`REFLEXMESH_*` child environment values are removed before launch. Actual Read
and hook processes run against synthetic localhost Messages, with no real model
inference, account, user profile, remote decision provider or paid API request.

Both fresh scenarios require 17 assertions, not simply an exit code:

- Exact generated direct-hook configuration, absent inherited deployment values
  and explicit shadow/abstain, remote-disabled binding.
- One native fixture Read and successful final result in one session; ordered
  prompt/pre/post/Stop hook responses with matching IDs, success codes, `{}`
  output and no stderr except the exact known Node SQLite experimental warning.
- Exactly one hello request, two Messages requests and no token-count request;
  the second request carries the random proof read from the unchanged fixture.
- One exact ledger key and ready schema-3 pair; current action/task-scope
  digests and a single harness-reported result matching the native typed payload.
- Zero independent labels and no raw summary, random proof or dummy credential
  in inspected ledger evidence.
- Default capture-off has missing task evidence and creates no cache. Explicit
  summary opt-in has the selected summary digest and an empty cache at exit.

The last assertion does **not** attribute cleanup solely to Stop: subsequent
session disposal can also clear it. The separate wrapper-based local-loop probe
measures Stop-specific cleanup and injected duplicate delivery. These are
different evidence levels, not interchangeable claims.

## Negative controls and review corrections

Root ran an actual installed-host negative control with the generated settings
omitted. The local model exchange and native Read succeeded, but hook/ledger
assertions failed as required. Ignoring settings cannot pass using a preconfigured
parent observer environment.

A second actual control injected conflicting inherited ReflexMesh deployment
values. Generated settings won for the tested version: no wrong-path files were
created and the other 16 assertions passed. The intentionally violated
no-inherited-configuration assertion failed, as it should. This is narrow
observed precedence evidence, not a bypass of organizational policy.

Review found and corrected these static-readiness defects:

- The generator's ledger-path limit exceeded the kernel's 1024 characters.
  It now rejects 1025 before opening a database, with a 1024 positive control.
- Existing directory, non-regular or symlink intent-cache targets could appear
  ready. Metadata checks now reject them before canonical comparison without
  reading cache contents; ENOENT still allows a first-use path.
- Explicit UNC and device paths could reach filesystem metadata and network
  shares. Their lexical prefixes are now rejected before metadata access, with
  zero-call filesystem stubs verifying this order. This is not mapped-drive or
  comprehensive filesystem-alias detection.
- A missing production hook entry could appear ready. Doctor now emits the
  fixed `hook_entry_missing` action diagnostic.
- Windows rooted paths without a drive letter can refer to different files
  depending on the host drive. They are rejected instead of emitted unchanged.

Regression tests also reject modified wrappers/settings, foreign sessions,
missing/failed/misordered hooks, wrong result digests/provenance, unexpected
transport, raw ledger content, stale capture, labels, and malformed JSONL.
Doctor refusal, bounded timeout/output failure and ignored hooks cannot pass;
cleanup tests check server closure, scoped removal and an unrelated canary.
Invalid command arguments have fixed redacted output. Valid setup output
intentionally exposes the caller-selected paths and namespace, not secrets.

## Limits and reproduction

See the [first-run guide](CLAUDE-FIRST-RUN.md) for commands and manual settings
merge. Help works without a build. `npm run check` and all four offline demos
require no credentials; actual installed-host probes are not silently run in CI.

Static checks do not certify executable identity/version, every dependency or
build freshness, cache contents, parent-directory writability, storage locality,
or all aliases. Windows file-symlink creation was unavailable on this machine;
simulated metadata tests cover refusal, while real symlink creation is attempted
where supported. SQLite read-only inspection can touch WAL/SHM sidecars and is
not byte-for-byte filesystem immutability. History is sampled in key order, not
necessarily latest, and never proves the proposed deployment is loaded.

Actual-host coverage is Windows Claude Code 2.1.263 and one successful Read per
scenario, with the existing conservative ancestor/managed-policy refusal gates.
It is not an OS sandbox or full egress audit, default-profile compatibility,
real-model inference, other versions/platforms, cancellation/subagent/restart
coverage, production load/privacy certification or proof of all descendant
termination after timeout. No user settings were installed or edited. No
authorization, retry, label, schema or production hook behavior was broadened.
