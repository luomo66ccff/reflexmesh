# Claude failures: distinguish a reported error from an interrupted outcome

ReflexMesh records what the host reports without replacing its permissions or
tool results. Claude failure hooks now preserve an explicit interruption as
**harness-reported unknown**, instead of silently recording ordinary failure.

| Observed event | Recorded host outcome | What it does not establish |
| --- | --- | --- |
| `PostToolUse` | `succeeded` | Independent correctness, authorization or a truth label |
| `PostToolUseFailure`, `is_interrupt` absent or `false` | `failed` | That no partial external effect occurred, or that a retry is safe |
| `PostToolUseFailure`, `is_interrupt: true` | `unknown` | That the tool stopped cleanly or made no changes |
| Invalid interruption type, such as `"true"` | Observation rejected | A successful observation or permission to retry |

The optional flag follows Claude's documented
[failure-hook input](https://code.claude.com/docs/en/hooks#posttoolusefailure-input).
That documentation also distinguishes an abort reaching the failure hook from
cancellation of a running tool, which may produce an interrupted tool result
without this hook. **This change is not a complete cancellation observer.**
No transcript is read to guess the missing result, and no observation is
fabricated when the hook never arrives. Unexpected top-level failure-only
fields on a successful event are rejected rather than interpreted as success.

## Decision status and host outcome are different

A completed shadow decision can have an unknown reported host outcome. The
decision means the observer completed its assessment, not that the tool's
effects are known. This change does not turn that row into the execution
kernel's `UNKNOWN` state, alter recovery admission, or grant a retry.

Use the existing [evidence CLI](EVIDENCE.md) and [first-run doctor](CLAUDE-FIRST-RUN.md)
to inspect the separate status/provenance and warnings. `harness-reported`
remains distinct from independently supplied labels. Outcomes still require
the exact [durable pre/post association](CLAUDE-HOOK-PAIRING.md); conflicting
reports block pairing instead of replacing the earlier observation.

An interrupted result from an old call uses its admitted task, not the current
prompt. It does not clear or overwrite a newer selected task summary. Existing
Stop, StopFailure and SessionEnd cleanup remains unchanged.

Historical records are not reclassified: an older `failed` entry does not retain
enough information to infer whether an interruption flag was present. Existing
schema-2 migration preserves its observation without retroactive certification.

## Check real mixed outcomes without an account

With installed Windows Claude Code **2.1.263** and Node **22.16+**:

```powershell
npm ci --ignore-scripts
npm run compat:claude-failure -- --help
npm run compat:claude-failure -- --claude-command 'C:\path\to\claude.exe'
```

This opt-in check starts the installed native CLI with fresh temporary stores,
strict MCP configuration and synthetic localhost Messages. No model account,
real model inference, user profile or paid API is used. ReflexMesh stays
shadow/abstain with no remote decision provider. The only offered tool is a
fixed synthetic in-memory MCP fixture; built-in tools are disabled.

The fixture asks for one batch containing two calls to that same tool. One
returns success and one returns an MCP error result. Both tool bodies must
enter a shared barrier before either exits, proving overlapping execution
instead of inferring concurrency from a batch request. The MCP tool does not
read user files; its instrumentation writes only fixture receipts in that
temporary directory. The probe also creates its isolated settings and ledgers.

The check obtains doctor-generated settings and uses their production `env`
and `hooks` unchanged, without a hook wrapper. Inherited `REFLEXMESH_*` values
are removed before launching the CLI. It requires actual successful pre/post
hook responses, separate ready ledger pairs and per-call task/action/result
digests. A successful final answer alone cannot pass the check.

The native success result's content array matches its hook response evidence.
For the failed MCP call, the actual error hook evidence matches the native
`tool_result.content` string; the CLI's separate typed display value adds an
`Error: ` prefix. The verifier checks the observed error content, not that
display wrapper. This shape is version-specific evidence, not a general
cross-version contract.

All 19 assertions must pass. Unknown requests, wrong results, missing hooks,
failed overlap, foreign bindings, truth labels, output limits, timeout and
cleanup failure cannot become success. No automatic retry is used. The task
cache must be empty at process exit; this probe does not attribute that solely
to Stop rather than subsequent session disposal.

The real-host scenario verifies ordinary MCP failure plus concurrent success.
`is_interrupt: true` is tested separately using source-shaped payloads through
both real hook CLI entrypoints, **not by claiming a real host cancellation**.
See [dated results](VALIDATION-CLAUDE-FAILURE-EVIDENCE.md).

## Support limits

The [existing isolation limits](CLAUDE-LOCAL-LOOP.md) still apply: conservative
ancestor/managed-policy refusal, no policy override, no OS sandbox or complete
egress audit, no guarantee that all descendants terminate after a timeout.
Unknown versions/platforms fail closed. Tool annotations are claims for this
trusted fixture, not enforcement on arbitrary MCP servers. Broader cancellation,
default-profile behavior, restart, subagents and production load/privacy
certification remain open. No write permissions, execution retry, schema or
automatic label behavior is added.
