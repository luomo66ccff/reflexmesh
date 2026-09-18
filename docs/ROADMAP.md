# Roadmap / 可直接交给 Codex 的任务拆分

## Milestone 0 — implemented local prototype

- [x] Typed contracts, immutable snapshot, strict provider output validation.
- [x] Versioned memory-admission and tool-preflight packs.
- [x] Default shadow mode; separate authorization; read-only active execution.
- [x] Runtime deadlines and process-local idempotency.
- [x] In-memory and local JSONL audit sinks.
- [x] Jev HTTP adapter with injected-fetch tests.
- [x] Cost-normalized speculation planner and labeled calibration statistics.
- [x] Offline demos, tests, pinned build dependency, CI definition and publish script.
- [x] Remote repository creation and initial source publication.
- [ ] Remote CI evidence on the published repository.
- [ ] Real Jev account access and a live contract smoke test.

## Milestone 1 — durable single-node kernel (first priority)

Goal: a restart must not silently duplicate an admitted action.

Implement a SQLite adapter with transactional request admission, unique `(tenant, source, eventId)` keys, request fingerprint, leases, terminal records and explicit `unknown` recovery state. Keep audit and action state logically distinct. Add crash injection at every point between admission, external call and persisted outcome. Do not claim external exactly-once delivery.

Acceptance: two independent runtime instances cannot execute one logical action concurrently; same key/different request conflicts; restarting after an uncertain call demands reconciliation rather than automatically retrying.

## Milestone 2 — Memory Engine adapter

Expose candidate admission + read-time filtering behind one adapter. Preserve original source/provenance, namespaces, explicit sensitivity consent, versioned facts and deterministic TTLs. Keep conflicting candidates in review rather than overwriting existing facts.

Acceptance: sensitive content without consent cannot be persisted, deletion and expiry are enforced without model cooperation, cross-tenant retrieval is impossible under host authorization tests, and old/new facts remain attributable.

## Milestone 3 — real speculative prefetch

Implement exact tool/arguments/principal/tenant/version cache keys; bounded budgets and concurrency; cancellation and TTL; never prefetch writes. Do not permit authenticated reads to leak through a shared cache.

Acceptance: measured end-to-end latency versus no-prefetch baseline, hit/use rate, wasted calls, extra cost and privacy-negative tests. Include precise tool-argument prediction, not only tool-name prediction.

## Milestone 4 — Saga-style action lifecycle

Add persisted prepared intent, single-use approval bound to payload hash/version/expiry, postcondition checks from independent tool evidence, registered compensators and failure reconciliation. Begin with a local disposable fixture, not production deployments.

Acceptance: duplicate approval/replay rejected, payload changes invalidate approval, timeouts remain unknown, compensation failures are visible, irreversible effects require explicit acceptance.

## Milestone 5 — DecisionOps and integrations

Policy replay from stored answers; labeled dataset import; threshold sweeps and reliability diagrams; model/pack comparison; audited human-reviewed configuration promotion. Then authenticated HTTP/MCP adapters and a dashboard. Never replay actual actions during evaluation.

Acceptance: changing a provider alias does not silently change an evaluated deployment; reports carry label provenance and sample count; no automatic security-threshold loosening from absence of incidents.

## Not goals yet

A generic visual workflow builder, autonomous deployment agent, replacement for auth/OPA, custom Jev weights, a distributed event broker, or an npm release. Prefer one tested consumer integration over many empty packages.
