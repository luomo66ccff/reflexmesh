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

Start with an account-free, explained walkthrough:

```bash
npm ci --ignore-scripts
npm run demo:evidence
```

It shows why a missing task suppresses assessment, why a completed decision is not a host result, and why a new task cannot inherit old evidence. Every prediction/outcome in this walkthrough is labeled synthetic. No model or host tool runs. To read a real local ledger, use `npm run evidence -- list --db PATH` and `npm run evidence -- inspect --db PATH --key KEY`; see the [evidence CLI guide](docs/EVIDENCE.md).

Connecting DeepSeek for the first time? Run `npm run doctor -- --help` for the
[read-only first-run diagnostics](docs/DOCTOR.md). It explains missing build,
installation and configuration prerequisites and prints a configuration snippet
without changing your profile or loading credentials. Historical ledger evidence
is kept separate from the still-unverified live connection.

For the full development checks and other offline examples:

```bash
npm ci --ignore-scripts
npm run check
npm run demo
npm run demo:durable
npm run demo:recovery
```

The demos use explicitly labeled synthetic fixtures, not real Jev predictions. The durable demo closes and reopens SQLite, reuses the decision without another model call, and tests a stricter policy without executing any tool. Generated `dist/` is ignored by Git; build before running adapter entrypoints.

The test runner processes independent test files sequentially to limit unrelated
resource contention. Tests that explicitly spawn competing OS processes retain
that concurrency; this setting does not serialize the production runtime.

## What is implemented

| Capability | Scope in this alpha |
| --- | --- |
| Evidence-bound deployment | Event/action digest + immutable pack version/hash + provider/model/revision + host authorization/toolset revisions |
| Durable admission | SQLite WAL, transactional uniqueness, leases and fencing epochs; separate-process tests and real process-kill tests |
| Recovery | Durable UNKNOWN tombstones plus local, preview-first operator reviews; conclusions never enable replay or retries |
| Portable contracts | Additive `binary / choice / ordinal` authoring facade; legacy `noul / score` remain inside the v0.1 engine |
| Codex | Tools-only STDIO MCP advisory endpoint; **does not intercept native shell/file tools** |
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` shadow CLI; always abstains from permission changes |
| DeepSeek Harness | Loader-ready shadow plugin with opt-in claimed-task summaries; isolated CLI/Agent tool round trip verified with synthetic and authorized real-model transport; broader lifecycle matrix remains open |
| Outcome evidence | Bound to exact tool and arguments; raw output not persisted; model/harness observations cannot automatically create labels |
| Evidence browser | Read-only CLI with bounded pages, decision explanations, task coverage and outcome provenance; no provider or tool invocation |
| Policy replay | Same question contract, different policy; no model calls, execution callbacks or side effects |
| Existing v0.1 modules | Memory admission suggestions, Jev/Mock, deterministic policy, authorized reads, Brier/ECE and speculation planner retained |

**Initial alpha verification:** 79 offline tests passed before the recovery-review change, including spawned MCP/Claude protocol processes and SQLite process-kill/race tests. Actual Codex, Claude Code and DeepSeek applications were **not installed or exercised** in that environment. Real Jev inference was **not run**. See the [initial validation](docs/VALIDATION.md) and [recovery validation scope](docs/VALIDATION-RECOVERY.md).

**Historical CLI baseline (2026-09-19):** Codex CLI 0.155.0-alpha.9.2 passed an isolated STDIO MCP smoke, and Claude Code 2.1.263 passed a prompt/hook/read/outcome path with zero labels. Those paths were not rerun for this increment. See [VALIDATION-REAL-HOSTS.md](docs/VALIDATION-REAL-HOSTS.md) for exact assertions and untested boundaries. Codex/Claude opt-in probes may invoke a logged-in host/model; they are not part of offline CI.

**DeepSeek increments:** the installed 0.1.2-rc.1 native tool pipeline and isolated CLI/profile/Agent loop have been exercised. The reproducible repository probe uses a synthetic adapter and remains account-free. A separate authorized [real-model validation](docs/VALIDATION-DEEPSEEK-REAL-MODEL-T001.md) passed one isolated tool round trip using the official `deepseek-v4-flash` route (11/11 assertions, two requests). ReflexMesh itself remains abstaining; this is neither a second decision provider nor a default-profile or complete lifecycle certification. The [Loader setup guide](docs/DEEPSEEK-AGENT.md) avoids custom identity/lifecycle callbacks; the [programmatic plugin](docs/DEEPSEEK-HOST.md) remains available. See the [synthetic Agent-loop validation](docs/VALIDATION-AGENT-LIFECYCLE.md), [first-run doctor validation](docs/VALIDATION-FIRST-RUN.md), and [open acceptance gates](docs/ITERATION-STATE.md).

DeepSeek post-dispatch cancellation now retains an unknown reported outcome.
The optional [lifecycle check](docs/DEEPSEEK-LIFECYCLE.md) also exercises actual
parallel tool bodies, task replacement and followup through the installed
Agent loop with synthetic model transport. See its
[dated verification and exclusions](docs/VALIDATION-DEEPSEEK-LIFECYCLE.md).

The optional [subagent-isolation check](docs/DEEPSEEK-SUBAGENTS.md) exercises
official in-process spawn children with separate task/result evidence, even
when call IDs repeat. Delegated child summaries stay model-reported rather than
being upgraded to user-origin evidence by the host's message wrapper. See the
[verification scope](docs/VALIDATION-DEEPSEEK-SUBAGENTS.md).

In-process DeepSeek and function-call observers also require a successful
before-observation for that invocation before recording its outcome. Conflicting
call IDs cannot attach new-task results to an old decision; DeepSeek checks that
the admitted call and Agent/session references have not changed. See the
[admission-pairing validation](docs/VALIDATION-OUTCOME-ADMISSION.md).

## Review an unknown execution

The local [recovery CLI](docs/RECOVERY.md) provides bounded listing, read-only inspection, review preview and explicit application. A review is tied to the exact input digest and epoch, records an operator/evidence reference, and rejects stale concurrent submissions.

```bash
node adapters/recovery-cli.mjs list --db /private/path/shadow.sqlite
node adapters/recovery-cli.mjs inspect --db /private/path/shadow.sqlite --key RUN_KEY
node adapters/recovery-cli.mjs review --db /private/path/shadow.sqlite --file review.json
# Only after checking external evidence and quiescing the original executor:
node adapters/recovery-cli.mjs review --db /private/path/shadow.sqlite --file review.json --apply
```

**A reviewed action remains `unknown` for execution purposes.** Review conclusions are separate administrative evidence, not replayable successes, new permissions, automatic retries or calibration labels. Review tools are deliberately not added to MCP. Actor references are operator-provided identifiers, not authentication; protect management access separately from same-user shell-capable agents.

Writable opens migrate SQLite schema 1 to 2 transactionally. Read-only inspection/preview can open schema 1 without migration. Stop old workers and back up the database before upgrading; old binaries reject schema 2. See the migration/runbook in [RECOVERY.md](docs/RECOVERY.md).

New label admissions also validate against the stored question contract: binary targets are `0/1`, choices must be declared, and ordinal targets are rubric indices. Inherited properties and undeclared fields are rejected. Existing historical labels are not rewritten.

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

An epoch fences admission and journal writes, not an arbitrary external API. A process can die after an external action succeeds but before recording its result. We preserve that uncertainty; we do not promise external exactly-once effects or ACID rollback. Local recovery reviews now record operator conclusions without removing UNKNOWN tombstones; no automatic resolution/retry or administrative UI is provided.

Tenant/session keys separate records but are not authentication. Use trusted ingress and a private local database directory. The ledger is not encrypted or tamper-proof; hashes and model labels may still reveal information. Read [SECURITY.md](SECURITY.md) and the [alpha safety limits](docs/DURABLE-SHADOW.md#limits).

## Development direction

The research-to-code decision is recorded in [ADR-0001](docs/ADR-0001.md). The proposed second-provider capability boundary is documented in [PROVIDER-CONFORMANCE.md](docs/PROVIDER-CONFORMANCE.md); it is not implemented yet. Next priorities are deeper real-host compatibility, provider conformance, retention tooling, independently verified recovery evidence and a bidirectional Memory Engine adapter. Dashboard, distributed broker, generic workflow editor, automatic writes and full Saga remain outside this alpha.

Repository: https://github.com/luomo66ccff/reflexmesh

MIT. No Jev weights are included; no affiliation with or endorsement by the model or harness vendors is implied.
