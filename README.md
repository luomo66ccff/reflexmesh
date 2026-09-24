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

Node.js **22.16+ is the API floor, not sufficient for persistent ledger writes**.
The actual SQLite must include the known WAL-reset fix; run
`node adapters/runtime-cli.mjs` before setup. Tested combinations are Node
22.23.2 / SQLite 3.51.3 and Node 24.19.0 / SQLite 3.53.3. Older/unknown affected
runtimes are blocked before writable ledger open; read-only inspection remains
available. See the [runtime requirement and manual upgrade guide](docs/SQLITE-RUNTIME.md).
TypeScript 5.8.3 is the sole build dependency; no third-party runtime packages
are required. The adapter uses Node's built-in, experimental `node:sqlite` API
on a **single machine / local filesystem**.

Start with an account-free first-run check and synthetic evidence lesson:

```bash
npm ci --ignore-scripts
npm run first-run
```

The command first checks this Node process's SQLite WAL-write requirement, builds the project, then shows why a missing task suppresses assessment, why a completed decision is not a host result, and why a new task cannot inherit old evidence. Every prediction/outcome is synthetic; no model, account, user profile or host tool is used. The temporary lesson is removed at exit.

To keep an inspectable synthetic ledger in a **new directory** and try the read-only CLI against it, use `npm run first-run -- --out-dir evidence-lesson`. Existing paths are never overwritten. The output's `START-HERE.md` contains copyable `list`, `attention` and `inspect` commands. This is still a fixture, not your deployment data. For a real local ledger, see the [evidence CLI guide](docs/EVIDENCE.md).

After a restart, `npm run evidence -- attention --db PATH` gives a read-only,
paged list of decision rows with missing/uncertain outcome evidence, ambiguous
hook pairing, or execution recovery requirements. It never infers a crash or
authorizes a retry; missing shadow reports remain separate from run UNKNOWN.
An empty list is not a health certificate. See the [attention guide](docs/EVIDENCE.md#find-evidence-that-needs-attention).

Wondering what is growing in a local ledger? `npm run evidence -- storage --db PATH`
shows bounded table/state counts, pair-only guards and database/WAL/SHM logical
sizes. It distinguishes truncated samples from totals and reusable SQLite pages
from disk-space reclamation. `npm run demo:storage` explains it without an
account. This is read-only diagnosis, not cleanup; see the
[storage guide](docs/STORAGE-DIAGNOSTICS.md).

Need a consistent archive before an operational change? `npm run demo:backup`
shows a live-WAL synthetic backup, isolated restore and a stale-snapshot
counterexample without an account. `node adapters/backup-cli.mjs --help` gives
the new-directory-only create/verify workflow. Whole-file checks retain UNKNOWN
and pairing evidence but never authorize replacing a current ledger or retrying
an action. See the [backup guide](docs/LEDGER-BACKUP.md).

Need to reclaim already-free SQLite pages without losing history?
`npm run demo:compaction` shows backup-bound preview and explicit maintenance,
with all seven logical tables and no-retry guards preserved. It is physical
compaction, not age-based deletion or secure erasure. Use
`node adapters/compaction-cli.mjs --help` and the
[compaction guide](docs/LEDGER-COMPACTION.md) before a real local rewrite.

Need to move older audit history out of the online ledger? `npm run demo:archival`
shows two backup-bound archival batches and verified historical lookup, without
an account. The opt-in [audit archival guide](docs/AUDIT-ARCHIVAL.md) covers
explicit schema 4, retained execution guards and external archive availability.
It deletes selected audit rows, not tombstones; keep every referenced backup.

Connecting DeepSeek for the first time? Run `npm run doctor -- --help` for the
[read-only first-run diagnostics](docs/DOCTOR.md). It explains missing build,
installation and configuration prerequisites and prints a configuration snippet
without changing your profile or loading credentials. Historical ledger evidence
is kept separate from the still-unverified live connection.

Connecting Claude on Windows? `npm run doctor:claude -- --help` starts the
[read-only setup guide](docs/CLAUDE-FIRST-RUN.md): explicit paths, seven generated
production hooks and capture off by default, with no settings or account changes.
`npm run compat:claude-setup` separately verifies the generated fragment through
exactly pinned installed Claude Code 2.1.263 or 2.1.280 with account-free
synthetic local transport.

Already have Claude Code 2.1.263 or 2.1.280 on Windows? `npm run compat:claude-local`
checks a real native Read and hook/ledger lifecycle with **local synthetic
Messages, no account and no model inference**. It also checks that an injected
duplicate observer delivery blocks ambiguous evidence without stopping the
native Read. See [setup, pinned support and isolation limits](docs/CLAUDE-LOCAL-LOOP.md)
and the [2.1.280 validation boundary](docs/VALIDATION-CLAUDE-HOST-2-1-280-T001.md).

For the full development checks and other offline examples:

```bash
npm ci --ignore-scripts
npm run check
npm run demo
npm run demo:durable
npm run demo:recovery
```

The demos above use explicitly labeled synthetic fixtures, not real model predictions. The durable demo closes and reopens SQLite, reuses the decision without another model call, and tests a stricter policy without executing any tool. Generated `dist/` is ignored by Git; build before running adapter entrypoints.

For one opt-in, paid independent-provider round trip with synthetic input,
start with `npm run demo:deepseek -- --help` and the
[DeepSeek decision-provider guide](docs/DEEPSEEK-PROVIDER.md). No request runs
without `--execute` and explicit remote/key/model/revision configuration. This
is separate from the DeepSeek Harness Loader, which still abstains by default.

Comparing providers? `npm run demo:comparison` explains how a candidate can
appear better simply by failing harder cases. Keep editable inputs with
`npm run demo:comparison -- --out-dir comparison-lesson`. The new
`npm run evaluation -- --help` workflow separates datasets, independently
supplied labels and separately bound prediction runs. Its main delta uses the
same labeled, both-successful cases, with missing/failure coverage beside it.
Validate and compare stay offline; paid runs need explicit opt-in and budgets.
See the [paired comparison guide](docs/PROVIDER-COMPARISON.md). No automatic
winner, calibration transfer, model promotion or tool execution is implied.

The test runner processes independent test files sequentially to limit unrelated
resource contention. Tests that explicitly spawn competing OS processes retain
that concurrency; this setting does not serialize the production runtime.

## What is implemented

| Capability | Scope in this alpha |
| --- | --- |
| Evidence-bound deployment | Event/action digest + immutable pack version/hash + provider/model/revision/capabilities digest + host authorization/toolset revisions |
| Independent decision providers | Jev and independent DeepSeek binary JSON estimates, immutable capability declarations and fail-before-egress conformance; no calibration or automatic fallback |
| Paired evaluation | Versioned datasets, separate label files, independently bound prediction artifacts and per-question paired metrics/coverage; descriptive only, no automatic promotion |
| Durable admission | SQLite WAL, transactional uniqueness, leases and fencing epochs; separate-process tests and real process-kill tests |
| Recovery | Durable UNKNOWN tombstones plus local, preview-first operator reviews; conclusions never enable replay or retries |
| Portable contracts | Additive `binary / choice / ordinal` authoring facade; legacy `noul / score` remain inside the v0.1 engine |
| Codex | Tools-only STDIO MCP advisory endpoint; **does not intercept native shell/file tools** |
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` shadow CLI with durable cross-process outcome pairing; always abstains from permission changes |
| DeepSeek Harness | Loader-ready shadow plugin with opt-in claimed-task summaries; isolated CLI/Agent tool round trip verified with synthetic and authorized real-model transport; broader lifecycle matrix remains open |
| Outcome evidence | Bound to exact tool and arguments; raw output not persisted; model/harness observations cannot automatically create labels |
| Evidence browser | Read-only CLI with bounded pages, decision explanations, task coverage and outcome provenance; no provider or tool invocation |
| Storage diagnostics | Read-only schema-1/2/3/4 table/state/pair-only samples and file/page metadata; no deletion, age eligibility or retry authority |
| Consistent ledger archives | Native SQLite online backup into a new private directory, offline integrity/hash verification and synthetic isolated restore/no-retry lesson; no production overwrite restore |
| Ledger compaction | Backup-bound preview, exclusive maintenance and complete logical-content verification; explicit local VACUUM, no historical row deletion or automatic retry |
| Audit archival | Explicit backup-bound audit deletion with per-run coverage and one-batch verified lookup; all execution guards retained, external archive chain not automatically verified |
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

Separate-process Claude hooks now persist pre/post association in the ledger.
Repeated, missing, interrupted or conflicting observed pre-hooks cannot silently
attach a later result to an older decision. Ambiguous historical reports remain
visible with a pairing warning. This requires trusted host IDs and has explicit
pre-reservation limits; see the [pairing and upgrade guide](docs/CLAUDE-HOOK-PAIRING.md).
The installed Claude application has also been rechecked against this pairing
protocol using the account-free [local transport probe](docs/VALIDATION-CLAUDE-LOCAL-LOOP.md).
This is narrow actual-host evidence, not real-model or default-profile certification.

Claude failure hooks now preserve an explicit interruption as a reported
`unknown` outcome, separate from completed shadow decisions. The account-free
`npm run compat:claude-failure` check exercises an actual overlapping success
and failure through isolated MCP tools and direct production hooks. Real host
cancellation is not implied; see [failure evidence and limits](docs/CLAUDE-FAILURE-EVIDENCE.md).

`npm run compat:claude-resume` verifies two separate installed Claude processes
using the same isolated synthetic session: clean exit and an owned-process kill
at a persisted tool-entry barrier. New prompts replace or clear old task summaries;
missing prior results stay visible through `evidence attention`. This does not
certify unattended continuation, default profiles or exactly-once execution.
See [cold-resume usage and verification boundaries](docs/CLAUDE-COLD-RESUME.md).

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

Writable opens migrate SQLite schemas 1 and 2 to 3 transactionally; fresh ledgers remain 3. Only explicit audit archival upgrades to 4, atomically with coverage and deletion. Read-only inspection supports 1–4 without migration, and ordinary writes never downgrade 4. Stop all old workers and make a consistent backup before upgrading; fresh-open version checks cannot revoke old open connections. Existing outcomes are preserved, not retroactively certified. See [recovery](docs/RECOVERY.md) and [archival](docs/AUDIT-ARCHIVAL.md).

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

For independent DeepSeek assessment, use `REFLEXMESH_PROVIDER=deepseek`,
`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` and the same explicit remote/revision/scope
settings. Only binary questions are supported. The model writes the numeric
answers itself: they are **uncalibrated subjective estimates**, not measured
classifier confidence or a claim that an action is safe. See the
[provider guide](docs/DEEPSEEK-PROVIDER.md) and
[bounded validation](docs/VALIDATION-INDEPENDENT-PROVIDER-T001.md).

The returned model must exactly match the binding; a different identifier fails
closed. Matching aliases do not prove unchanged backend weights. Capabilities
are validated, frozen and bound into durable identity, with no automatic
fallback, calibration fitting or model migration. Switching binding for the
same event ID raises a conflict; stop old workers and start a separately named
shadow deployment. Existing schema-3 records are not backfilled with invented
capabilities; historical projections expose missing fields as null.

## Design boundaries

The original `ReflexMesh` class remains an in-memory runtime. **Only `DurableMesh` with `SqliteKernel` adds persistence.** SQLite replays decision/status metadata, not previous raw tool outputs: this is not a cross-session tool-output cache.

All harness adapters in this alpha are **shadow/advisory**. They observe host-owned tools, including host-permitted writes, but never execute or authorize them. Active execution through the library remains limited to explicitly registered, host-authorized reads. No write approvals, compensators or speculation executor have been added.

An epoch fences admission and journal writes, not an arbitrary external API. A process can die after an external action succeeds but before recording its result. We preserve that uncertainty; we do not promise external exactly-once effects or ACID rollback. Local recovery reviews now record operator conclusions without removing UNKNOWN tombstones; no automatic resolution/retry or administrative UI is provided.

Tenant/session keys separate records but are not authentication. Use trusted ingress and a private local database directory. The ledger is not encrypted or tamper-proof; hashes and model labels may still reveal information. Read [SECURITY.md](SECURITY.md) and the [alpha safety limits](docs/DURABLE-SHADOW.md#limits).

## Development direction

The research-to-code decision is recorded in [ADR-0001](docs/ADR-0001.md).
The implemented declaration and fail-before-egress boundary is documented in
[PROVIDER-CONFORMANCE.md](docs/PROVIDER-CONFORMANCE.md). Next priorities are
representative independent-model comparisons, deeper real-host
compatibility, safe retention beyond read-only diagnostics, independently verified recovery evidence and
a bidirectional Memory Engine adapter. Dashboard, distributed broker, generic
workflow editor, automatic writes and full Saga remain outside this alpha.

Repository: https://github.com/luomo66ccff/reflexmesh

MIT. No Jev weights are included; no affiliation with or endorsement by the model or harness vendors is implied.
