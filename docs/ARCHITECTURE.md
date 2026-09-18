# Architecture / 架构约束

## Unified contract

`Event -> Pack -> ProviderResult -> PolicyVerdict -> HostAuthorization -> Action -> Outcome`.

The provider returns evidence-like assessments. Policy is versioned, deterministic code/data. Authorization is a separately supplied host function. The runtime must not turn a model's recommendation into a permission grant.

The current event envelope is our own schema, not a claim of full CloudEvents compatibility. Events are processed in one Node.js process, not delivered by a distributed broker.

## Trust boundaries

1. Host ingress authenticates callers, derives tenant/principal identity, limits payload sizes and approves provider egress. Never trust a client-supplied tenant ID just because it parses.
2. Decision packs, tool metadata and authorization functions are trusted deployment configuration. Retrieved documents, model output and user text cannot register tools or change policies.
3. Provider output is checked against the exact question set, result types, allowed choice labels, finite numeric ranges and probability mass. Score is an expected rubric value, not a category index.
4. The policy's `allow` means only that a semantic rule matched. The runtime still requires a registered read tool, explicit principal and `authorize(...) === true`.
5. All writes/destructive actions are blocked in the prototype. There is no implemented approval token protocol to bypass this intentionally conservative limit.

## Idempotency and audit

The idempotency key is `(tenantId, source, event.id)`. Canonical request identity also includes the event, requested action/principal and full pack definition. Same key plus different identity is a conflict, not a second execution.

Concurrent same-key requests share one promise. The entry is retained after success, uncertainty or rejection. Capacity causes backpressure rather than silently deleting tombstones. This retains request state in process memory; it is not encrypted storage or a privacy guarantee.

The JSONL ledger records decisions and outcomes but **cannot reconstruct/reinstate** action tombstones on restart. Audit persistence and idempotency persistence are independent concerns. A distributed deployment needs an atomic durable admission store and an application-specific recovery protocol before enabling writes.

Audit append failure before tool execution prevents the tool call. Failure after execution rejects the run and retains a failed promise. The caller must not reinterpret that rejection as proof that nothing happened.

The runtime omits raw event state, action args, outputs and provider error bodies from its audit. Hashes are unsalted fingerprints, not anonymization. Pack names, choice labels, event identifiers and model metadata may still be sensitive. Audit storage still needs ACLs, retention/deletion controls and tamper protection.

## Memory Governor

The current pack assesses usefulness, expected stability, duplication, sensitivity and conflict. It returns `propose_persist`, `propose_ttl`, `drop`, `review_privacy` or `resolve_conflict`. It does not perform extraction, vector search, persistence, consent checks or deletion.

A future Memory Engine adapter should enforce provenance, explicit consent, namespace isolation, versioned facts, deterministic timestamp expiry and deletion independently of the model. Read-time relevance/contradiction assessment should use source evidence and must not silently rewrite user facts.

## Speculation

The prototype planner takes a known candidate set and trusted metadata. It does not infer executable arguments, call tools, or reuse cached results.

`expectedNetUsd = P(use) * latencySavedMs * latencyValueUsdPerMs - costUsd - riskPenaltyUsd`.

All terms are explicitly converted to dollar-equivalent utility; subtracting milliseconds directly from dollars would be invalid. The planner uses a greedy baseline, not a globally optimal knapsack solver. Probabilities must refer to the same planned tool + arguments, not just a tool name in isolation.

Only already-authorized, explicitly speculatable, non-sensitive, idempotent read candidates are eligible. Read/GET does not imply harmlessness: accesses can consume quota, leak query data or expose sensitive information. Actual prefetch requires per-tenant/principal cache keys, exact-argument hashes, TTL, cancellation, budget accounting, freshness checks and a way to establish that the main agent really consumed the prefetched result.

## Saga is not two-phase commit

The proposed transaction layer is a future **Saga-like action lifecycle**, not ACID 2PC. External actions such as sending messages cannot generally be undone. A compensation may mitigate an effect without erasing it.

Future stages: persisted intent -> authorization bound to exact action/version -> bounded execution -> independent postcondition evidence -> accepted outcome or compensation/recovery. Compensators must be registered host functions; never execute model-generated rollback commands. Unknown execution outcome requires reconciliation before retry. Even durable local intent cannot guarantee exactly-once effects across arbitrary external services.

## DecisionOps and calibration

Audit provides observations; labels require independent evidence. There is no automatic threshold adjustment in v0.1. Brier score/ECE are reports over supplied labels, not certification that any provider is safe.

Use task-specific held-out labels, report sample counts and class balance, and separate provider/model/pack versions. A high-risk action followed by no incident is not a negative risk label; outcomes are censored and counterfactual outcomes are unobserved. Human approvals are authorization decisions, not necessarily truth labels.

## Current deployment recommendation

Use an in-process library inside a trusted local app. Start in shadow mode. Do not expose `run()` as an unauthenticated public endpoint. Add distributed storage, authenticated ingress and failure-recovery tests before a multi-service gateway. MCP, Next.js/FastAPI integration and a dashboard are roadmap items, not shipped integrations.
