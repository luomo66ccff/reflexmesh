# ReflexMesh

**把同一份语义决策契约，跨 Agent 宿主变成可持久化、可追溯、可回放的证据。**

A provider-neutral semantic decision runtime: **one contract, durable evidence, multiple harnesses**.

> **v0.2.0-alpha.1 — Durable Shadow Protocol.** Experimental, not a production security boundary.
> We extend Codex, Claude Code and DeepSeek Harness; we do not replace their agent loops or permission systems.

```text
Codex STDIO MCP       Claude Code hooks       DeepSeek Harness hooks
   advisory              shadow observer          shadow observer
       \                      |                       /
                 normalized HarnessCall
                           |
              SQLite admission + deployment binding
                           |
               versioned Pack -> Provider -> Policy
                           |
                Decision evidence <-> Host outcome
                           |
             independent labels / policy-only replay
```

## Run the current branch

Node.js **22.16+**, npm. TypeScript 5.8.3 is the sole build dependency; no third-party runtime packages are required. The new adapter uses Node's built-in, experimental `node:sqlite` API on a **single machine / local filesystem**.

```bash
npm ci --ignore-scripts
npm run check
npm run demo
npm run demo:durable
```

The demos use explicitly labeled synthetic fixtures, not real Jev predictions. The durable demo closes and reopens SQLite, reuses the decision without another model call, and tests a stricter policy without executing any tool. Generated `dist/` is ignored by Git; build before running adapter entrypoints.

## What is implemented

| Capability | Scope in this alpha |
| --- | --- |
| Evidence-bound deployment | Event/action digest + immutable pack version/hash + provider/model/revision + host authorization/toolset revisions |
| Durable admission | SQLite WAL, transactional uniqueness, leases and fencing epochs; separate-process tests and real process-kill tests |
| Recovery | Pre-execution expired admission can be reclaimed; an execution with unknown outcome is **never automatically retried** |
| Portable contracts | Additive `binary / choice / ordinal` authoring facade; legacy `noul / score` remain inside the v0.1 engine |
| Codex | Tools-only STDIO MCP advisory endpoint; **does not intercept native shell/file tools** |
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` shadow CLI; always abstains from permission changes |
| DeepSeek Harness | Source-matched `tools/pre-execute` + `tools/result` observer; preserves `next()` and supports disposal |
| Outcome evidence | Bound to exact tool and arguments; raw output not persisted; model/harness observations cannot automatically create labels |
| Policy replay | Same question contract, different policy; no model calls, execution callbacks or side effects |
| Existing v0.1 modules | Memory admission suggestions, Jev/Mock, deterministic policy, authorized reads, Brier/ECE and speculation planner retained |

**Verification:** 79 offline tests passed during this change, including spawned MCP/Claude protocol processes and SQLite process-kill/race tests. Actual Codex, Claude Code and DeepSeek applications were **not installed or exercised** in that environment. Real Jev inference was **not run**. See [validation](docs/VALIDATION.md).

## Connect a harness

First build, then configure the **absolute Node entrypoint**, not an npm command that prints build banners onto protocol stdout.

Codex example (`config.toml`; replace the path):

```toml
[mcp_servers.reflexmesh]
command = "node"
args = ["/absolute/path/to/reflexmesh/adapters/mcp-server.mjs"]
env = { REFLEXMESH_PROVIDER = "abstain", REFLEXMESH_SCOPE = "my-project" }
```

This installs **advisory** tools: `reflexmesh_assess`, `reflexmesh_observe_outcome`, `reflexmesh_replay_policy`, `reflexmesh_inspect_pack`. The model may choose not to call them. It does not gain or lose native tool permissions.

Claude hook configuration, DeepSeek observer wiring, generic function-call middleware, shared configuration and limitations are documented in [DURABLE-SHADOW.md](docs/DURABLE-SHADOW.md). No installer edits your settings or credentials.

### Honest default: abstain, not fabricated confidence

With no provider configuration, events are recorded but the judgment escalates as **provider unavailable**. No fake probability and no external network request is substituted. For explicit Jev use, configure server-side environment variables:

```text
REFLEXMESH_PROVIDER=jev
REFLEXMESH_ALLOW_REMOTE=true
TYPESAFE_API_KEY=<your local secret, never commit>
TYPESAFE_MODEL=<account-supported model ID>
REFLEXMESH_PROVIDER_REVISION=<your evaluated deployment revision>
REFLEXMESH_SCOPE=<project scope>
```

The returned model must match the binding. An alias that resolves to a different model will fail closed rather than silently inheriting old thresholds. Full provider-capability negotiation, calibration fitting and automatic model migration are **not shipped**. Switching binding for the same event ID raises a conflict; start a separately named shadow deployment for comparisons.

## Design boundaries

The original `ReflexMesh` class remains an in-memory runtime. **Only `DurableMesh` with `SqliteKernel` adds persistence.** SQLite replays decision/status metadata, not previous raw tool outputs: this is not a cross-session tool-output cache.

All harness adapters in this alpha are **shadow/advisory**. They observe host-owned tools, including host-permitted writes, but never execute or authorize them. Active execution through the library remains limited to explicitly registered, host-authorized reads. No write approvals, compensators or speculation executor have been added.

An epoch fences admission and journal writes, not an arbitrary external API. A process can die after an external action succeeds but before recording its result. We preserve that uncertainty; we do not promise external exactly-once effects or ACID rollback. No automatic UNKNOWN resolution or administrative recovery UI is provided yet.

Tenant/session keys separate records but are not authentication. Use trusted ingress and a private local database directory. The ledger is not encrypted or tamper-proof; hashes and model labels may still reveal information. Read [SECURITY.md](SECURITY.md) and the [alpha safety limits](docs/DURABLE-SHADOW.md#limits).

## Development direction

The research-to-code decision is recorded in [ADR-0001](docs/ADR-0001.md). Next priorities are full provider conformance, real-host compatibility tests, bounded recovery/retention tooling and a bidirectional Memory Engine adapter. Dashboard, distributed broker, generic workflow editor, automatic writes and full Saga remain outside this alpha.

Repository: https://github.com/luomo66ccff/reflexmesh

MIT. No Jev weights are included; no affiliation with or endorsement by the model or harness vendors is implied.
