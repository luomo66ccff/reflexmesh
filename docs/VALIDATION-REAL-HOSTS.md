# Real-host compatibility validation

This report records a narrow compatibility milestone, not production
certification. The final probe runs below used committed adapter code at
`f4b5ee681c98` (`reflexmesh` `0.2.0-alpha.1`) on 2026-09-19.

## Environment and isolation

- Windows 11 Home, build 26200, x64
- Node.js 24.19.0 and npm 11.17.0
- Codex CLI 0.155.0-alpha.9.2
- Claude Code 2.1.263
- `@deepseek-ai/dsh` 0.1.2-rc.1
- provider mode: `abstain`; no Jev request or synthetic probability

The probe starts native executables with `shell: false`, bounds runtime and
captured output, and reports fixed failure codes rather than child output. It
uses temporary databases/settings and removes them after each run. It does not
edit host configuration or copy credentials. The hosts still use their own
existing authentication, and Claude's tested OAuth setup requires its user
settings source; that is part of the tested environment, not a portable auth
claim. Loading that source can also load existing user environment/settings or
hooks. The tested user settings had no hooks, but the probe does not certify
isolation from arbitrary user or managed configuration.

## Result matrix

| Host | Version | Status | Evidence boundary |
| --- | --- | --- | --- |
| Codex CLI | 0.155.0-alpha.9.2 | **passed** | Actual CLI loaded the temporary STDIO MCP server, made exactly one structured `reflexmesh_inspect_pack` call, received success, emitted no other recognized tool-call event, and returned the exact marker. |
| Claude Code | 2.1.263 | **passed** | Actual CLI delivered `UserPromptSubmit -> PreToolUse -> Read -> PostToolUse`; the isolated SQLite ledger contained a run, ready task-evidence receipt, succeeded outcome, and zero labels. |
| DeepSeek Harness | 0.1.2-rc.1 | **discovered, not exercised** | The installed native package entrypoint returned its version. No plugin was loaded and no `tools/pre-execute` or `tools/result` event was exercised. |

Final sanitized timestamps were `2026-09-19T09:25:06.854Z` for Codex,
`2026-09-19T09:27:11.589Z` for Claude, and
`2026-09-19T09:27:32.129Z` for DeepSeek discovery.

## What the passing probes establish

### Codex CLI

The run ignored user configuration/rules while retaining host-owned login,
used a read-only sandbox, exposed only `reflexmesh_inspect_pack`, and applied
Codex's per-tool `approval_mode = "approve"` to that one inspection MCP tool.
The analyzer accepts only a typed `mcp_tool_call` event and an exact final
marker; prompt or assistant prose mentioning the tool cannot satisfy it.

This is a real MCP connection smoke test. It does **not** establish that Codex
will always call advisory assessment tools, and it does not exercise
`reflexmesh_assess`, a native Codex tool, or model-reported outcome attachment.

### Claude Code

The run used a temporary settings file, no session persistence, an empty strict
MCP configuration, Chrome disabled, slash commands disabled, and only the
built-in `Read` tool. A temporary `PreToolUse` guard denied every path except
the generated fixture. The model issued exactly one structured `Read` for that
fixture and returned the exact marker.

The actual task hook selected only the explicit first-line summary. Durable
inspection verified at least one run, one `ready` task-evidence receipt, one
outcome, one `succeeded` host-reported outcome, and zero calibration labels.
The outcome remains harness-reported evidence, not independently verified truth
or authorization. Subagent identity was not exercised.

### DeepSeek Harness

Discovery used the installed package's native Node entrypoint rather than a
`.cmd`/`.ps1` shell shim. It proves only that the expected version is present.
Source-shaped callback tests remain offline tests; they are not a substitute
for loading the observer through the real plugin lifecycle.

## Reproduction

Build before probing. These commands may invoke the logged-in host/model and
are intentionally not part of CI:

```powershell
npm run build
node scripts/real-host-compat.mjs --host codex
node scripts/real-host-compat.mjs --host claude
node scripts/real-host-compat.mjs --host deepseek `
  --deepseek-command <native-node-executable> `
  --deepseek-command-arg <installed-dsh-lib-bin.js>
```

`npm run compat:hosts -- --host <codex|claude|deepseek|all>` is the packaged
entrypoint. On Windows, explicit host overrides must be native `.exe`/`.com`
executables; shell shims are rejected. DeepSeek discovery therefore needs the
native Node executable plus its installed package entrypoint when only `dsh.cmd`
is on `PATH`.

## Offline verification

On the same committed code:

- `npm run check`: 171 tests, 170 passed, 0 failed, 1 skipped. The skip is the
  Windows unprivileged recovery-input symlink case; it is not reported as a
  pass.
- `node examples/workflow.mjs`: passed.
- `node examples/durable-shadow.mjs`: passed.
- `node examples/recovery-review.mjs`: passed.
- `node examples/task-intent.mjs`: passed.
- `git diff --check`: passed.

CI now declares Ubuntu/Node 22, Windows/Node 22 and Windows/Node 24 jobs. Those
new remote jobs have not run because this local branch has not been pushed.

## Failures found while building the baseline

- Windows profile aliases caused direct ESM entrypoints to compare unequal and
  silently do nothing. Entrypoints now compare canonical paths and a real
  junction/symlink subprocess regression covers execution versus import.
- Codex initially refused the MCP call under global `approval = never`; the
  final probe explicitly approves only the one exposed inspection MCP tool.
- Claude `--restricted` did not make the existing OAuth login available in the
  tested build. The final probe loads the user settings source for host-owned
  authentication, then narrows the tool surface and applies an exact-path
  guard. This does not prove isolation from every possible user environment or
  managed setting.

Only the final runs in the result matrix count as passing evidence.

## Remaining gaps

- DeepSeek Harness plugin loading, real hook events, disposal, cancellation and
  host/session/agent identity propagation
- Codex assessment/outcome workflow and native tool correlation
- parallel tools, cancellation, host crash, shutdown races and process restart
  for every host
- real Claude subagent identity and stale-summary behavior across real agents
- real Jev inference, independent provider conformance and any calibration
  claim
- remote CI results for the new Windows matrix
- production authorization, OS isolation, retention, load and privacy testing

Decision completion must not be confused with host execution completion. A
cancelled or crashed host without an outcome remains missing/unknown; no probe
in this milestone changes the no-retry rule for UNKNOWN execution state.

## External references checked

- Codex MCP configuration and tool approval modes:
  https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Claude Code hook lifecycle and JSON input/output:
  https://code.claude.com/docs/en/hooks
- DeepSeek Harness tool execution pipeline:
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md
