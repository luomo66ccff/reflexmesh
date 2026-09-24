# Roadmap / 研究结论驱动的工程路线

Updated for **v0.2.0-alpha.1**, 2026-09-19. See [ADR-0001](ADR-0001.md) for positioning and [DURABLE-SHADOW](DURABLE-SHADOW.md) for the implemented protocol. Version labels describe scope, not promised delivery dates.

The current incremental evidence and unfinished acceptance gates are tracked in
[ITERATION-STATE.md](ITERATION-STATE.md). Earlier validation reports remain dated snapshots.

## Implemented alpha slice

- [x] Preserve the v0.1 runtime, deterministic policy, Jev/Mock adapters and all 45 original tests.
- [x] Add portable binary/choice/ordinal pack authoring without silently breaking legacy callers.
- [x] Persist immutable pack hashes and explicit provider/model/revision/host bindings.
- [x] Add SQLite WAL admission, duplicate detection, lease epochs and conservative unknown states.
- [x] Exercise reopen, independent connections, simultaneous OS processes and real SIGKILL boundaries.
- [x] Normalize harness events and bind reported outcomes to exact action arguments.
- [x] Add Codex advisory STDIO, Claude shadow hooks, source-matched DeepSeek observers and generic function-call middleware.
- [x] Separate observations from independently supplied labels; add pure policy-only replay.
- [x] Initial alpha baseline: 79 offline tests and both offline demos passed.
- [x] Add local, preview-first recovery reviews with epoch/digest compare-and-set; preserve UNKNOWN tombstones.
- [x] Add read-only inspection, transactional schema-2 migration and typed label validation.
- [x] Add 32 focused recovery/label tests and a credential-free recovery demo; see [validation scope](VALIDATION-RECOVERY.md).
- [x] Add an isolated real-host probe and exercise pinned Codex and Claude smoke paths; see [validation](VALIDATION-REAL-HOSTS.md).
- [x] Add a read-only evidence CLI and account-free explained walkthrough, with explicit task coverage and outcome provenance.
- [x] Load the observer through installed DeepSeek/Cordis native tool components, including disposal and pre-dispatch cancellation; classification is synthetic.
- [x] Exercise DeepSeek's CLI profile Loader and actual Agent loop with an isolated synthetic model adapter, bound task receipt and observed plugin cleanup; see [validation](VALIDATION-AGENT-LIFECYCLE.md).
- [x] Exercise one authorized isolated real-model DeepSeek Agent/tool round trip with bounded official transport; see [t001 evidence and limits](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md).
- [x] Add read-only DeepSeek first-run doctor separating prerequisites, historical evidence and unverified live loading; see [guide](DOCTOR.md).
- [x] Preserve native DeepSeek post-dispatch cancellation as unknown and verify fixed installed-host parallel/task-replacement/cancel/followup scenarios with synthetic model transport; see [validation](VALIDATION-DEEPSEEK-LIFECYCLE.md).
- [x] Preserve model-reported provenance for delegated DeepSeek summaries and verify official sequential spawn isolation with repeated call IDs and per-call result digests; see [validation](VALIDATION-DEEPSEEK-SUBAGENTS.md).
- [x] Pair in-process DeepSeek/function-call outcomes with successful admission and reject mid-call identity/action changes; see [validation](VALIDATION-OUTCOME-ADMISSION.md).
- [x] Persist Claude cross-process pre/post pairing, retain ambiguous outcomes with explicit warnings, and exercise duplicate/order/process-death boundaries without a model; see [protocol and limits](CLAUDE-HOOK-PAIRING.md).
- [x] Offer an account-free installed Claude CLI/native Read/hook loop using strict synthetic localhost Messages, including duplicate-observer rejection; see [setup and limits](CLAUDE-LOCAL-LOOP.md).
- [x] Generate Claude production hooks through a read-only first-run doctor and verify that exact settings fragment in isolated installed CLI capture-off/explicit-summary scenarios; see [guide](CLAUDE-FIRST-RUN.md).
- [x] Preserve explicitly interrupted Claude reports as unknown and verify overlapping success/failure through installed CLI, fixed MCP tools and direct production hooks; real cancellation remains separate. See [evidence and limits](CLAUDE-FAILURE-EVIDENCE.md).
- [ ] Exercise default-profile compatibility and the broader lifecycle matrix; one isolated real-model result does not close this gate.
- [ ] Run an authorized real-Jev contract smoke test. Never put its key in the repository.

## Next: v0.2 alpha hardening

**First gate: actual host compatibility and useful evidence.** Run each real host against the adapter, including cancellation, parallel tools, agent identity and shutdown. Record which CLI/plugin revision passed. Capture host-owned task intent through an explicit minimization policy rather than treating tool-only evidence as a complete task description. Do not silently read full transcripts or inherit credentials.

The real-host baseline covers one Codex MCP smoke, one Claude prompt/hook/read/outcome path, a DeepSeek native tool pipeline, isolated DeepSeek CLI/Agent round trips with synthetic and authorized real-model transport, and fixed official spawn-child isolation with synthetic transport. Default-profile compatibility and a complete cross-host cancellation, parallel-tool, subagent and restart matrix remain open. A discovered executable is not counted as an exercised host.

**Second gate: provider conformance.** Introduce declared capabilities and a genuinely independent local/structured provider. A provider lacking probabilities must not fabricate them. Evaluate separately named champion/challenger deployments; binding mismatches must never silently inherit old thresholds.

The implemented capability schema and rejection/conformance matrix are recorded
in [PROVIDER-CONFORMANCE.md](PROVIDER-CONFORMANCE.md). Jev and an independent
DeepSeek binary JSON estimate provider share the offline conformance runner.
One bounded authorized real-provider shadow round trip is separate from host
model transport; see [validation](VALIDATION-INDEPENDENT-PROVIDER-T001.md).
This closes the initial capability/transport implementation, not provider
quality, calibration, broad host latency or champion/challenger acceptance.
An account-free [evaluation preflight](VALIDATION-EVALUATION-PLAN-T001.md)
now previews trusted capability coverage and a request upper bound before
paid comparison; it does not replace independent quality labels, money
budgets, model-route checks or user review of the outbound dataset. Its
[PR/main integration readback](VALIDATION-EVALUATION-PLAN-INTEGRATION-T001.md)
keeps remote CI distinct from the local validation.
An optional [plan-to-run guard](VALIDATION-EVALUATION-PLAN-GUARD-T001.md)
now rejects accidental dataset/provider/request-cap drift before key access;
it is not authenticated approval or a monetary budget.
Its [PR/main integration readback](VALIDATION-EVALUATION-PLAN-GUARD-INTEGRATION-T001.md)
keeps CI evidence separate from local behavior checks.
A separate [declared-route guard](VALIDATION-EVALUATION-ROUTE-PLAN-T001.md)
also detects accidental model ID/revision drift before key access. It does
not verify backend weights, authenticate an account or cap monetary spend.
Its [PR/main integration readback](VALIDATION-EVALUATION-ROUTE-PLAN-INTEGRATION-T001.md)
keeps remote CI separate from the local behavior evidence.
The next [wire-size preflight](VALIDATION-EVALUATION-WIRE-PREFLIGHT-T001.md)
separates capability compatibility from exact locally serialized request-body
compatibility when a route is declared. The runner skips known unsendable
cases without spending a request slot; endpoint, model quality and cost are
still outside this check.

**2026-09-22 sequencing decision:** after the bounded Claude cold-resume and
read-only attention increment, the next implementation milestone moves to
capability declarations and a genuinely independent provider. This is an
engineering priority adjustment, **not closure of the first gate**. Restart of
one pinned isolated Claude session is now exercised; the broader host matrix
stays open, support claims do not expand, and newly discovered lifecycle
blockers take priority. Repeatedly adding isolated happy-path probes must not
indefinitely defer the defining question: does ReflexMesh still stand without Jev?

**Third gate: recovery and retention.** Local operator review is now available ([runbook](RECOVERY.md)), including read-only preview, atomic review/audit and schema-1 migration tests. It records conclusions without authorizing retries or rewriting execution truth. Remaining work: independently authenticated operator evidence, crash-safe retention that preserves action tombstones, lease-budget validation and cancellation propagation. Audit storage and idempotency storage remain distinct concepts. No external exactly-once claim.

**2026-09-22 operational increment:** independently labeled paired report tooling
is now available, with a real same-route synthetic workflow smoke rather than a
quality claim. The new [storage diagnostics](STORAGE-DIAGNOSTICS.md) provide
bounded read-only table/state/pair-only coverage and file/page metadata before
any retention design. Neither diagnostic closes the broader host, quality or
operational gate. Actual reclamation and verified restore must preserve admission
and pairing guards; no automatic deletion or UNKNOWN retry is introduced.

**2026-09-22 runtime compatibility correction:** Node 22.16 is only an API
floor; its SQLite 3.49.1 predates the upstream WAL-reset fix. A real in-memory
version probe now blocks affected/unknown persistent writers before ledger
creation/migration, while preserving read-only diagnosis. Both doctors and a
build-free [runtime preflight](SQLITE-RUNTIME.md) explain manual upgrade/restart.
Pinned old-runtime negative tests complement supported Node 22/24 suites.
The subsequent [consistent backup increment](LEDGER-BACKUP.md) captures a pinned
WAL snapshot into a new standalone archive, verifies it offline and exercises
isolated synthetic restoration with replay/UNKNOWN/pairing guards intact.
It also demonstrates that a valid old archive lacks newer admission tombstones.
This is not production restore authorization, authenticated freshness or closure
of the operational gate. Next: design retention/review that preserves admission
and pairing guards; never overwrite a live ledger or discard newer tombstones.

**2026-09-22 all-record compaction:** an explicit backup-bound preview/apply
workflow now reclaims existing free pages/fragmentation under exclusive local
maintenance while retaining all logical rows and no-retry/pairing guards.
[Guide](LEDGER-COMPACTION.md) and [validation](VALIDATION-LEDGER-COMPACTION-T001.md)
separate actual synthetic main-file shrinkage from physical allocation, secure
erasure and historical deletion. No schema migration is needed for this step.

**2026-09-22 audit archival:** explicit backup-bound audit deletion, online
batch/per-run coverage, highwater sequence protection and verified one-batch
lookup are implemented in the [archival increment](AUDIT-ARCHIVAL.md). Only apply
upgrades to schema 4; all non-audit evidence and execution guards stay online.
Backups/compaction distinguish legacy seven-table v1 and nine-table v2 formats.
This does not certify external archive availability, production recovery, total
space reduction, privacy compliance or large-ledger load. Further pruning of
observations/labels/reviews/packs still requires ID/body/version tombstones.

**2026-09-24 first-run iteration:** `npm run first-run` combines the actual
SQLite WAL-write preflight, build, and a concise synthetic evidence lesson. An
optional new-only output directory keeps a local lesson ledger and copyable
read-only `list` / `attention` / `inspect` commands; task-summary text remains
temporary. This reduces first-run friction, but it is not live-host setup or
proof of real provider quality. See the bounded
[validation report](VALIDATION-FIRST-RUN-T003.md).
Review follow-up [t004](VALIDATION-FIRST-RUN-T004.md) prevents a successful
first-run receipt from claiming temporary cleanup before it is verified;
injected cleanup failures now fail instead of being silently ignored.
[PR #23](https://github.com/luomo66ccff/reflexmesh/pull/23) is merged; its
[t005 integration report](VALIDATION-FIRST-RUN-T005.md) records exact-head and
post-merge CI without promoting local first-run evidence to live-host proof.
The subsequent Windows Node 22 hook-fixture CI failure and bounded test-only
repair are recorded in [t006](VALIDATION-FIRST-RUN-T006.md); this is not a
runtime hook latency result.
The [t007 narrated first-run lesson](VALIDATION-FIRST-RUN-T007.md) now
explains the task/decision/host-outcome/label separation in its default
summary and gives a next step, without adding a host or model dependency.
Its [t008 integration readback](VALIDATION-FIRST-RUN-T008.md) keeps exact
PR/main CI evidence separate from the local user-facing check.

**2026-09-24 Claude host compatibility:** [PR #27](https://github.com/luomo66ccff/reflexmesh/pull/27)
merged strict support for installed Claude Code 2.1.280, with isolated native
Read/hook, generated setup, failure, and two-process cold-resume probes. The
different interrupted-tool transcript is checked without promoting a synthetic
error result into execution success. [Local evidence](VALIDATION-CLAUDE-HOST-2-1-280-T001.md),
[exact-head CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36015864180),
and [main CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36016402182)
are distinct. The 2.1.263 binary was not rerun in this increment, and broad
host compatibility remains open.

**2026-09-24 DeepSeek shutdown boundary:** [PR #29](https://github.com/luomo66ccff/reflexmesh/pull/29)
merged bounded observer result reception, truthful missing-outcome attention,
and early-result/reentrant-disposal protections. The Loader keeps its kernel
open until already running admission and captured-result writes settle. See
[local validation](VALIDATION-DEEPSEEK-SHUTDOWN-T001.md),
[exact-head CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36022213089),
and [main CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36022911086).
The installed host's missing-result teardown and indefinitely hung callback
paths remain outside those passing host scenarios; the reception window is not
a host-tool timeout or total shutdown deadline.

**2026-09-25 installed DeepSeek teardown boundary:** [PR #31](https://github.com/luomo66ccff/reflexmesh/pull/31)
merged an opt-in isolated installed-host probe. It unloads the observer while
one native tool body is pending, verifies bounded drain and a truthful missing
ledger outcome, then allows a late host result and natural Agent exit. See
[local validation](VALIDATION-DEEPSEEK-TEARDOWN-T001.md),
[exact-head CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36027435510)
and [main CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36027994173).
It does not cover permanent result absence, hung callbacks, real-model
transport or the default user profile.

**2026-09-25 DeepSeek live drain diagnostics:** [PR #33](https://github.com/luomo66ccff/reflexmesh/pull/33)
fixed a waiting-period missing-count misreport and added payload-free live
drain snapshots plus one fixed warning when callbacks are still pending at
the result-window boundary. The Loader still waits for in-flight storage
before closing its kernel. See [local validation](VALIDATION-DEEPSEEK-DRAIN-T001.md),
[exact-head CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36032221796)
and [main CI](https://github.com/luomo66ccff/reflexmesh/actions/runs/36032645585).
This is diagnosability, not a bounded total unload or cancellation protocol.

**Next acceptance priority:** bounded host shutdown/cancellation and isolated
first-run gaps within the existing adapters, especially permanent missing-result
and hung-callback behavior with a safe storage-write barrier or isolation
contract, followed by representative
independent-model quality and larger operational tests. The merged first-run
lesson does not close those gates or authorize a release, profile change or
new paid model work.

**2026-09-25 fenced-drain integration:** [PR #35](https://github.com/luomo66ccff/reflexmesh/pull/35)
merged the Loader's opt-in
`shutdownDrainWaitMs` with a revocable, built-in synchronous SQLite boundary.
Local tests prove deadline isolation of pending callbacks, late-access refusal,
truthful drain/close receipts and retention of already committed evidence.
See [local validation](VALIDATION-DEEPSEEK-FENCE-T001.md) and the distinct
[PR/main CI readback](VALIDATION-DEEPSEEK-FENCE-INTEGRATION-T001.md).
Installed-host regressions passed without injected forever-pending callbacks.
Next: installed-host permanent-result-loss and broader hung-callback
scenarios, then representative independent-model quality. An isolated
[installed-host fence probe](VALIDATION-DEEPSEEK-FENCE-HOST-T001.md) now
exercises one deliberately delayed `after` callback through the official
Loader and native Agent; [PR #37 integration](VALIDATION-DEEPSEEK-FENCE-HOST-INTEGRATION-T001.md)
is verified, but arbitrary or permanent hangs remain unproven.
This feature does not certify whole-host cancellation or arbitrary callbacks.

## v0.3: memory governance and calibrated comparison

Connect the existing Memory Engine through an adapter, not a new memory database. Add read-time relevance/staleness/conflict assessment; enforce consent, tenant namespace, TTL and deletion in host code. Preserve competing facts and provenance rather than overwriting them on a model's opinion.

Build an explicit labeled evaluation dataset, per-pack/provider reports and paired replay/migration gates. Measure coverage, false-allow/false-deny, Brier/ECE and label provenance. Host success or human approval is not automatically truth. Keep any dashboard downstream of usable CLI reports.

## Experimental track: safe speculation

Keep the current planner labeled as a planner. Before executing prefetch, implement exact tool+argument+principal+tenant+data-version keys, authorization before dispatch, bounded cost/concurrency, expiry, and stale-result checks. Evaluate against a no-prefetch baseline and report wasted calls as well as latency. Never speculate writes.

## v1 gates, not current claims

A future enforcement release requires credential-isolated tool boundaries, independent review, explicit approvals bound to exact payload/version/expiry, registered compensators where meaningful, postcondition evidence and operator recovery. Saga compensation does not undo an irreversible action or provide ACID rollback.

Only then consider authenticated HTTP/MCP distribution, Postgres/multi-node coordination, retention controls, full provider migration and a DecisionOps UI. All require real-host tests and failure/load/privacy evaluation.

## Non-goals

No new agent loop, generic visual workflow engine, model training stack, IAM/OPA replacement, memory database, automatic threshold loosening from absence of incidents, or premature multi-package framework. Reuse those layers; make the bound decision/evidence contract the product's center.
