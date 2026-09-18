# Roadmap / 研究结论驱动的工程路线

Updated for **v0.2.0-alpha.1**, 2026-09-18. See [ADR-0001](ADR-0001.md) for positioning and [DURABLE-SHADOW](DURABLE-SHADOW.md) for the implemented protocol. Version labels describe scope, not promised delivery dates.

## Implemented alpha slice

- [x] Preserve the v0.1 runtime, deterministic policy, Jev/Mock adapters and all 45 original tests.
- [x] Add portable binary/choice/ordinal pack authoring without silently breaking legacy callers.
- [x] Persist immutable pack hashes and explicit provider/model/revision/host bindings.
- [x] Add SQLite WAL admission, duplicate detection, lease epochs and conservative unknown states.
- [x] Exercise reopen, independent connections, simultaneous OS processes and real SIGKILL boundaries.
- [x] Normalize harness events and bind reported outcomes to exact action arguments.
- [x] Add Codex advisory STDIO, Claude shadow hooks, source-matched DeepSeek observers and generic function-call middleware.
- [x] Separate observations from independently supplied labels; add pure policy-only replay.
- [x] Run 79 offline tests and both offline demos locally.
- [ ] Run actual Codex, Claude Code and DeepSeek Harness applications with pinned versions.
- [ ] Run an authorized real-Jev contract smoke test. Never put its key in the repository.

## Next: v0.2 alpha hardening

**First gate: actual host compatibility and useful evidence.** Run each real host against the adapter, including cancellation, parallel tools, agent identity and shutdown. Record which CLI/plugin revision passed. Capture host-owned task intent through an explicit minimization policy rather than treating tool-only evidence as a complete task description. Do not silently read full transcripts or inherit credentials.

**Second gate: provider conformance.** Introduce declared capabilities and a genuinely independent local/structured provider. A provider lacking probabilities must not fabricate them. Evaluate separately named champion/challenger deployments; binding mismatches must never silently inherit old thresholds.

**Third gate: recovery and retention.** Add bounded operator reconciliation for UNKNOWN, crash-safe retention that preserves action tombstones, database migration tests, lease-budget validation and cancellation propagation. Audit storage and idempotency storage remain distinct concepts. No external exactly-once claim.

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
