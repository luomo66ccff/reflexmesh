# Durable Shadow Protocol — v0.2.0-alpha.1

## One tested slice, not the whole research roadmap

The new layer consists of `SqliteKernel`, `DurableMesh`, `ShadowBoundary`, generic `HarnessCall` normalization, and three harness-facing observer surfaces. The existing TypeScript engine is reused, not replaced. A portable pack authoring facade bridges `binary/choice/ordinal` to the legacy contract.

```text
trusted host configuration                     untrusted evidence
provider/model/revision, tenant/scope       tool name/args, user intent
               \                                  /
                 admission identity + contract hash
                              |
                      question/policy decision
                              |
                    immutable evidence record
                              |
                  reported outcome != truth label
```

## Local persistence and recovery

SQLite uses WAL, synchronous FULL and transactional uniqueness. Identity includes tenant, source, event ID, semantic event content, run options, pack and deployment binding. Observation timestamp is excluded; a task that depends on time must put that time in its semantic state. Same ID with changed arguments or binding is an error, not a second execution.

State transitions:

```text
admitted --successful decision/no action--> completed
   |                                           |
   | expired: reclaim with epoch+1              +--> metadata-only replay
   |
   +--persist action.started--> executing --settled--> completed
                                   |
                          timeout/crash/uncertainty
                                   |
                                 unknown
                                   |
                          recovery_required (no retry)
```

Lease ownership and epoch are checked before journal transitions, especially before the tool body. An expired `executing` admission is never handed to another executor. The scheme prevents a second library-managed invocation on that logical ID; it cannot revoke an already dispatched remote action. Lease duration should exceed the complete bounded run; there is no renewal protocol yet. Unknown states have no automatic cleanup/retry endpoint.

`DurableMesh` removes in-flight promises after settling, while SQLite keeps the deduplication records. Persisted results deliberately omit raw tool output. A replayed success is metadata, not a cached result or a fresh authorization. There is no retention/garbage-collection API in this alpha, and you must not delete live tombstones as if they were disposable logs.

## HarnessCall v1

```ts
interface HarnessCall {
  schemaVersion: 1;
  harness: 'codex' | 'claude-code' | 'deepseek-harness' | 'openai-compatible';
  sessionId: string;
  agentId: string;
  callId: string;
  toolName: string;
  arguments: Json;
}
```

The host supplies trusted tenant/scope outside this envelope. Session/agent/call IDs are namespace identifiers, not credentials. A host observer's outcome must match the original tool name and arguments. Raw result bytes are hashed, not retained. Neither `model-reported` nor `harness-reported` means independently verified ground truth.

## Shared configuration

Build first with `npm run build`. Entry points read process environment, **not `.env` automatically**:

| Variable | Default / meaning |
| --- | --- |
| `REFLEXMESH_PROVIDER` | `abstain`; records an unavailable-provider escalation without network or fake scores |
| `REFLEXMESH_DB` | `~/.reflexmesh/shadow.sqlite`; use a private local path, never a network filesystem |
| `REFLEXMESH_TENANT` | `local`; derived/configured by trusted host, not a caller-granted identity |
| `REFLEXMESH_SCOPE` | `default`; assign a distinct project scope to avoid ID collisions |
| `REFLEXMESH_ALLOW_REMOTE` | Must equal `true` before entrypoints send tool arguments to Jev |
| `TYPESAFE_API_KEY` | Server-side secret, used only in explicit Jev mode |
| `TYPESAFE_MODEL` | Required in Jev mode; must match actual response model |
| `REFLEXMESH_PROVIDER_REVISION` | Required in Jev mode; user-controlled deployment revision, not proof of calibration |

New DB files/directories use restrictive permissions on supporting platforms. Existing directories/files are not silently reconfigured. A model alias may change or return a concrete name; a binding mismatch deliberately escalates. Use tested model IDs and separate deployment scopes when changing providers. No actual Jev access was tested in this change.

## Codex: advisory MCP, not native-tool interception

Use this in Codex's MCP configuration, replacing the absolute path (Windows paths such as `C:/dev/reflexmesh/...` are acceptable):

```toml
[mcp_servers.reflexmesh]
command = "node"
args = ["/absolute/path/to/reflexmesh/adapters/mcp-server.mjs"]
env = { REFLEXMESH_PROVIDER = "abstain", REFLEXMESH_SCOPE = "my-project" }
```

The server implements a narrow **2025-06-18 STDIO tools profile**: initialization, initialized notification, ping, tools/list and tools/call. One newline-terminated JSON message per frame, maximum 256 KiB. There is no HTTP/OAuth, resource/prompt API, sampling, remote execution or complete general MCP SDK implementation. Stdout is protocol only. Client-version negotiation and behavior must still be checked with actual host versions.

Tools:

- `reflexmesh_assess({call,userIntent?})`: durable advisory assessment, `control: abstain`.
- `reflexmesh_observe_outcome({call,status,evidence})`: explicitly **model-reported**, not a trusted host observation or label.
- `reflexmesh_replay_policy({call,candidatePack?})`: validated same-question counterfactual, no model/tool execution.
- `reflexmesh_inspect_pack({})`: the installed contract and digest.

A model can skip these tools. Native Codex shell/files are untouched. Mandatory enforcement requires a separately designed credential-isolated tool proxy and is not claimed here. Do not configure an npm build command as the MCP command: npm banners would contaminate stdout.

## Claude Code: lifecycle shadow hooks

Merge these entries into the appropriate Claude settings; do not overwrite unrelated hooks. Replace each path. The hook inherits the shared configuration from the host process environment.

```json
{
  "hooks": {
    "PreToolUse": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/to/reflexmesh/adapters/claude-hook.mjs\"","timeout":10}]}],
    "PostToolUse": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/to/reflexmesh/adapters/claude-hook.mjs\"","timeout":10}]}],
    "PostToolUseFailure": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/to/reflexmesh/adapters/claude-hook.mjs\"","timeout":10}]}]
  }
}
```

Normalization uses `session_id`, optional `agent_id`, `tool_use_id`, `tool_name`, `tool_input`, and `tool_response`/`error`. The CLI accepts a bounded JSON object on stdin and returns `{}` with exit 0. It **never returns `permissionDecision: allow`** and never replaces tool input/output. Observation errors emit a static stderr warning and leave the host's existing policy unchanged. This is explicitly a shadow failure policy, not an enforcement-mode fail-open design. Hook execution still adds latency. This adapter does not read the full transcript or capture UserPromptSubmit; user intent is null unless supplied through a host-owned boundary call. Tool-only evidence is insufficient to certify that an action matches the full task.

## DeepSeek Harness: source-matched Cordis observer

`installDeepSeekObserver` attaches to real reviewed seams:

```js
import { installDeepSeekObserver } from './adapters/deepseek-plugin.mjs';

// Within a host-managed plugin/context; boundary is a configured ShadowBoundary.
const observer = installDeepSeekObserver(ctx, {
  boundary,
  identity: resolveTrustedSessionAndAgent, // (exec) => ({sessionId, agentId})
  onError: code => hostLogger.warn(code),
});
// On plugin shutdown, or in the host's owned cleanup lifecycle:
await observer.dispose();
```

`tools/pre-execute(exec,next)` observes `exec.callId`, `exec.name`, **`exec.arguments`**, then delegates with `next()`; it does not return a replacement allow decision. `tools/result(exec,result)` is a synchronous final-outcome observer, not the post-execute waterfall. It queues bounded observation work and exposes `flush`/`dispose`. Host result and permission decisions remain owned by DeepSeek. Errors are reported using fixed diagnostic codes. Queue overflow records a diagnostic and drops that observation instead of growing without bound.

The host must resolve authenticated session/agent identity. We deliberately do not guess a version-dependent `exec.agent.session` field or serialize the live context. This module was tested against callback fixtures derived from the reviewed tools source (Git blob `6be7be61e257cd9e38c8a3122298316bf3df9892`), **not an installed DeepSeek Harness runtime**. Plugin-loader registration, cancellation/latency behavior and actual host compatibility remain a release gate. The observer does not automatically extract the user request from the agent context; supply such evidence explicitly before evaluating intent-match quality.

## Generic function-call harnesses

`observeFunctionCall` in `adapters/openai-compatible.mjs` normalizes `id/type/function.name/function.arguments`, runs the before observer, calls your host-owned `execute` exactly once, records an outcome, and returns/rethrows the original result/error. A thrown tool body is recorded as `unknown`, not evidence that no side effect occurred. Observer failures do not add retries. This is middleware, not a DeepSeek API client or a new agent loop.

## Policy replay and labels

`replayPolicy(record,candidatePack)` accepts only completed valid predictions with the same event type and question digest. It evaluates candidate rules locally and returns `hypothetical:true, executionAllowed:false`. It is not a re-run against a new model. Labels require an explicit question ID and independent `human`/`test-oracle` provenance plus source reference; none of the MCP tools can create them.

## Limits

This alpha is local-first, shadow-first, and unaudited. No HTTP authentication, distributed broker, credential isolation, automatic raw-text secret redaction, transparent encryption, tamper-proof ledger, retention policy, manual recovery protocol, full calibrated-provider migration, real speculation, Saga compensator, memory DB or UI is shipped.

Raw input/output is not saved by the new boundary, but it may be sent to a configured remote provider. Digests are not anonymization; pack prompts, selected labels, identifiers and prediction metadata may contain information. SQLite namespace keys do not authenticate clients, and arbitrary processes with database access can modify records. Do not expose the local protocol as an unauthenticated network service. An unknown execution remains uncertain even after the process restarts.

For interface sources and rationale, see [ADR-0001](ADR-0001.md). For measured local verification and untested live-host paths, see [VALIDATION](VALIDATION.md).
