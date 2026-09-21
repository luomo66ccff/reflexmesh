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

**2026-09-22 sequencing decision:** after the bounded Claude cold-resume and
read-only attention increment, the next implementation milestone moves to
capability declarations and a genuinely independent provider. This is an
engineering priority adjustment, **not closure of the first gate**. Restart of
one pinned isolated Claude session is now exercised; the broader host matrix
stays open, support claims do not expand, and newly discovered lifecycle
blockers take priority. Repeatedly adding isolated happy-path probes must not
indefinitely defer the defining question: does ReflexMesh still stand without Jev?

**Third gate: recovery and retention.** Local operator review is now available ([runbook](RECOVERY.md)), including read-only preview, atomic review/audit and schema-1 migration tests. It records conclusions without authorizing retries or rewriting execution truth. Remaining work: independently authenticated operator evidence, crash-safe retention that preserves action tombstones, lease-budget validation and cancellation propagation. Audit storage and idempotency storage remain distinct concepts. No external exactly-once claim.

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
