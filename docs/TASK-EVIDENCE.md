# Task evidence: selected summaries, not hidden transcript capture

This optional v0.2 alpha slice follows the durable-shadow and recovery-review work. It adds a **TaskAwareBoundary**, explicit short-lived Claude task capture, and typed provenance for host-selected versus model-reported summaries. Existing observers remain available. No application settings are automatically edited, no host tools are executed by the new boundary, and no new permission or calibration-label API is exposed.

## Why another evidence boundary?

A tool call does not establish the user's goal. Asking a classifier whether the call matches a missing goal can produce confident but unsupported decisions. In task-aware mode, missing, oversized, suspicious or expired summaries suppress the provider call and result in an escalation. A provider's high score cannot override that evidence check. The check is repeated just before provider egress.

The same event records a bounded receipt: policy revision, summary digest, source, lifetime, scope digest and **coverage: summary-only**. It never claims that a short summary describes all user instructions. Source is provenance, not authenticated identity, factual correctness or authorization. MCP text is explicitly `model-reported` with `freshness: unverified`; it cannot manufacture a host timestamp through the tool schema.

This is a concrete implementation of evidence-bound decisions, not a claim of a novel memory database or a new agent framework. The selected-summary digest and capture policy join the existing event/pack/provider binding. Changing the task for an old call ID conflicts rather than silently changing what that historical call meant.

## Run the offline demonstration

```bash
npm ci --ignore-scripts
npm run build
node examples/task-intent.mjs
```

The demonstration uses synthetic predictions/outcomes. It shows no provider call without a summary, a single fixture prediction with a selected summary, decision reuse, and escalation after clearing the task. No actual model or host tool runs.

## Claude Code: explicitly select a summary

Use the new entrypoint **instead of** the previous `claude-hook.mjs` for tool hooks; do not configure both for the same call. Build first. Merge only these entries with your existing settings and replace the absolute path:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "PreToolUse": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "PostToolUse": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "PostToolUseFailure": [{"matcher":"*","hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "Stop": [{"hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "StopFailure": [{"hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}],
    "SessionEnd": [{"hooks":[{"type":"command","command":"node \"/absolute/path/reflexmesh/adapters/claude-task-hook.mjs\"","timeout":10}]}]
  }
}
```

Launch the host with `REFLEXMESH_INTENT_MODE=explicit-summary`. The default is `off`, so installing a hook alone does not opt into prompt storage. The hook inherits environment settings; it does not load `.env` or read `transcript_path`.

An opted-in prompt can begin:

```text
ReflexMesh-Intent: Fix the README links; do not edit source code or deploy anything.

Other task details and conversation text follow here.
```

Only the literal first line after `ReflexMesh-Intent: ` is selected. Keep all constraints needed for this advisory judgment in that summary. The remaining prompt is neither copied nor read from transcript files. A marker embedded later in the prompt does not count. A new prompt without a selected summary clears the old one rather than recycling the previous goal.

The maximum is **2048 UTF-8 bytes**, with no truncation. A small conservative credential-pattern detector withholds suspicious summaries entirely. It is **not a comprehensive secrets or personal-data scanner**: do not include sensitive data. Unknown formats, obfuscation and ordinary personal data may pass; full tool arguments still follow the pre-existing egress policy and are not newly redacted by this feature.

`PreToolUse` loads the matching session/agent summary. `Stop` and `StopFailure` clear that agent's current summary; `SessionEnd` clears the session within the configured tenant/project. Subagents never implicitly inherit the main agent's summary. When a summary is missing, the observer abstains and records an escalation without a classifier call. All hook responses remain `{}` with successful exit; this does not approve, deny or replace the host action. Observation can add latency, and unavailable storage can drop the observation with a fixed diagnostic. Default provider mode remains honest `abstain`, so capture alone does not enable live inference.

## Cache lifetime and privacy boundary

The optional cache is separate from the execution ledger. Default location: `task-intents.sqlite` beside `REFLEXMESH_DB` (or under `~/.reflexmesh`). `REFLEXMESH_INTENT_DB` overrides that location; it must not point to the execution database. Its application ID/schema guard rejects an existing ledger. New files/directories use restrictive permissions where supported; existing ACLs are not changed.

The cache intentionally contains the **selected summary in plaintext**. Default validity is ten minutes, with at most 128 active records across the file. Reads/writes prune expired records, and lifecycle clear removes selected records. **TTL prevents use after expiry; it does not promise wall-clock physical erasure while no process is running.** Journals, freed pages, backups, filesystem snapshots or a crash may leave recoverable data. `secure_delete` is not a complete secure-erasure guarantee. Disabling capture does not retroactively wipe a previously created file.

By contrast, the durable execution journal stores the receipt and digests, not the selected summary. Digests and IDs are not anonymization. Do not reuse task IDs for raw text, and treat metadata as potentially sensitive. Same-user processes can modify either database; this is not an authentication or OS-isolation boundary. The cache is local single-node infrastructure, not distributed memory. Explicit selection and expiry do not establish that the host delivered arbitrarily reordered events in the correct logical turn; the adapter uses the host's synchronous hook order.

## Codex: model-reported advisory summary

Keep the existing STDIO MCP command and opt into task-aware assessment:

```toml
[mcp_servers.reflexmesh]
command = "node"
args = ["/absolute/path/reflexmesh/adapters/mcp-server.mjs"]
env = { REFLEXMESH_PROVIDER = "abstain", REFLEXMESH_TASK_EVIDENCE = "true", REFLEXMESH_SCOPE = "my-project-task-v1" }
```

`reflexmesh_assess` keeps its existing `call` and `userIntent` arguments. In task-aware mode, the server labels the provided string as **model-reported**, not as directly captured user input, with unknown freshness. Its receipt records summary-only coverage. Omitting the string suppresses the classifier call. No MCP method can write host task capture records, set arbitrary provenance, or invoke the recovery administrator. Native Codex tools are not intercepted; the model can skip advisory tools entirely.

Task-aware and legacy modes have different deployment bindings. For existing data, use a new project scope to start a separate shadow evaluation rather than silently reusing old event IDs under a new policy. Actual model calls still require the existing explicit remote-egress opt-in and a configured provider key/model/revision. Do not put secrets into events or repository files.

## DeepSeek Harness and generic function-call loops

Both adapters accept an optional **pure synchronous** `resolveIntent` callback. Use them with a `TaskAwareBoundary` for strict evidence gating. No version-dependent agent/session property is guessed or automatically serialized:

```js
const observer = installDeepSeekObserver(ctx, {
  boundary: taskAwareBoundary,
  identity: resolveTrustedSessionAndAgent,
  resolveIntent: exec => hostTaskEvidenceByCallId.get(exec.callId) ?? null,
  onError: code => hostLogger.warn(code),
});
```

The host supplies an explicit envelope:

```js
{
  schemaVersion: 1,
  id: "host-task-revision-1",
  scope: { harness: "deepseek-harness", sessionId: "session-1", agentId: "agent-1" },
  source: "host-declared",
  summary: "Read the selected source files without modifying them",
  issuedAt: 1789730000000,
  expiresAt: 1789730600000
}
```

Use actual epoch milliseconds at capture, not the illustrative timestamps above. A host envelope needs a positive lifetime of at most ten minutes and an exact harness/session/agent match. A `resolveIntent` returning a Promise is rejected as an invalid observer configuration; it is never awaited as an unbounded extra workflow. Keep the resolver a local, bounded projection with no side effects. Arbitrary synchronous host code cannot be preempted by this library.

The DeepSeek adapter delegates `next()` unchanged and rechecks cancellation after the resolver. The generic `observeFunctionCall` calls the host's executor once and preserves its return value or thrown error, even if the observer/resolver fails. Neither path extracts a full transcript, invents an authenticated actor or upgrades model evidence to a human label.

The optional [DeepSeek Loader entrypoint](DEEPSEEK-AGENT.md) supplies a bounded
live task source without custom callbacks. Its official spawned-child prompts
may be generated by a parent model despite the host's user-message wrapper, so
they remain `model-reported` with unverified freshness and null envelope
timestamps. A separate private cache TTL still limits reuse. See the
[subagent provenance and isolation guide](DEEPSEEK-SUBAGENTS.md); a child does
not automatically inherit a parent's selected summary.

## Verification and remaining gaps

See [task-evidence validation](VALIDATION-TASK-EVIDENCE.md). Tests exercise real Node hook/MCP processes, SQLite reopening and separate-process startup, plus source-shaped DeepSeek callbacks. These are **not** end-to-end runs of installed Codex, Claude Code or DeepSeek Harness applications. No real Jev inference or production workload benchmark is claimed. Provider conformance, authenticated task provenance, full-context intent extraction and real-host installation remain separate work.

Implementation references checked 2026-09-18:

- Claude hook input/output and lifecycle: https://code.claude.com/docs/en/hooks .
- Codex STDIO configuration: https://developers.openai.com/zh-Hans/docs/extend/mcp .
- DeepSeek reviewed tool seams: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts ; reviewed blob `6be7be61e257cd9e38c8a3122298316bf3df9892`, reused without guessing new host fields.
- Pinned local SQLite API: https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html .
