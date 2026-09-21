# Check installed Claude hooks without an account

For first-time production setup, start with [doctor:claude](CLAUDE-FIRST-RUN.md).
Its separate `compat:claude-setup` probe verifies the generated direct hooks.
The probe on this page retains its test wrapper for duplicate-delivery injection
and Stop-specific receipt capture; the two evidence levels are distinct.

`compat:claude-local` exercises an **installed Claude Code CLI**, its native
`Read`, and actual hook processes against a **synthetic localhost Messages
fixture**. No real model inference or account is used. ReflexMesh stays shadow
and abstains. This opt-in check is separate from `compat:hosts`, which can use a
logged-in host/model, and from the default offline suite.

## Run

The installed-host check currently accepts **Windows and Claude Code 2.1.263
only**, with Node 22.16+. Other versions/platforms fail closed; the command does
not install, downgrade or change Claude. A version match is not a signature check:
the installed executable, OS environment and repository checkout must be trusted.

```bash
npm ci --ignore-scripts
npm run compat:claude-local -- --help
npm run compat:claude-local
# If the installed native executable cannot be discovered:
npm run compat:claude-local -- --claude-command "C:\path\to\claude.exe"
```

Expect one JSON report with `status: "passed"`,
`evidenceLevel: "installed_claude_local_transport"`, `modelInference: false`,
and two passed scenarios. npm may print build banners before that report;
after building, `node scripts/claude-local-probe.mjs` prints the report directly.
Do not treat a zero-exit host or final marker alone as a pass. Every assertion
and cleanup must pass. Failures stop the probe without retrying the host action.

| Scenario | Native action | Required durable evidence |
| --- | --- | --- |
| `single-read` | One real Read of the temporary synthetic file | One schema-3 ready pair, exact task/action/outcome digests, one harness-reported success, zero labels |
| `duplicate-pre` | The same isolated one-Read workflow in a fresh session | Test wrapper delivers the observed pre twice; pair becomes `blocked / duplicate_pre`, no outcome is admitted, native Read still finishes, zero labels |

The second scenario injects duplicate **observer delivery**. It does not claim
Claude spontaneously duplicated a hook or a tool execution. One wrapper per
event calls the real task-hook adapter and records minimized receipts in order;
this is not certification of every possible direct-entrypoint user installation.
The wrapper's fixture-only pre guard denies an unexpected Read target. It is
test infrastructure, not a permission feature added to the production observer.

Both scenarios require prompt/pre/post/Stop in one session and root-agent scope,
the same stdout and hook call ID, successful ordered host hook responses, and
cache emptiness measured immediately after the real Stop adapter returns.
StopFailure, an earlier SessionEnd, malformed receipts and ambiguous outcomes
cannot become a successful report.

## Isolation and refusal

Each scenario creates a fresh directory under writable Windows system Temp.
It contains a random synthetic file, separate Claude configuration, Anthropic
configuration, plugin cache, settings, task cache and ledger. The child receives
only an OS environment allowlist plus explicit probe settings: no inherited
credentials, proxies, code loaders, provider routes or profile pointers.
The model wire label `claude-sonnet-4-6` is used only to select a compatible CLI
wire format; all responses come from the local fixture, not that model.

The fixture listens on `127.0.0.1` on a random port and never connects upstream.
It accepts only bounded requests, one offered Read, its exact echoed call, and
the random file proof in a text tool result before returning the final marker.
The proof is not supplied in the prompt or synthetic tool-call response.
Reported token counts are fixed synthetic values, not billable usage evidence.

The runner selects empty configuration directories using the documented
[Claude environment settings](https://code.claude.com/docs/en/env-vars) and the
separate [Anthropic configuration directory](https://platform.claude.com/docs/en/manage-claude/wif-reference#configuration-directory).
It uses restricted mode, explicit settings, empty MCP configuration, only Read,
disabled skills/commands, no session persistence and noninteractive permission
handling. See the [CLI reference](https://code.claude.com/docs/en/cli-reference).

Before starting a session, existence-only checks reject any ancestor
`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or `.claude`. They also reject an
existing `%ProgramFiles%\ClaudeCode` directory or either Windows ClaudeCode
policy registry key; unavailable checks fail closed. These conservative checks
do not read or alter policy values. Managed policy can take precedence over
session settings; see [managed settings](https://code.claude.com/docs/en/managed-settings).
Do not remove organizational policy or personal context to force the probe to
pass; use a separately provisioned clean test environment instead.

This is **not an OS filesystem/network sandbox**, a hostile-binary test or a
network-egress audit. Trusted PATH/TEMP/system variables remain. Disabling
nonessential traffic is not a firewall. Windows child-tree termination is
best-effort, not proof that every descendant has exited after a forced timeout.
The runner closes SQLite and its server before deleting only its validated,
prefix-matched temporary child directory. Cleanup failure makes the report fail;
there is no broad deletion of user Temp, profiles or workspaces.

## Version-specific observations and failures

On the tested 2.1.263 executable, `--bare` with explicit `--settings` performed
the Read but did **not** execute these hooks. The evidence gate correctly failed.
This probe therefore omits `--bare` and uses the isolation checks above. The
[bare-mode documentation](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)
is not a promise that this pinned build executes explicit hooks in bare mode.

The same executable made one unauthenticated `HEAD /api/hello` before two
Messages requests. The fixture permits that exact body-free handshake once.
This is an observed, version-specific behavior, not a documented public API
contract. Unexpected routes, extra requests and mismatched results fail closed.

| Fixed reason | Meaning / next action |
| --- | --- |
| `host_command_not_found` / `unsupported_host_version` / `unsupported_host_platform` | Discovery or pinned support boundary; do not treat discovery as execution evidence. |
| `ambient_context_unverified` / `managed_configuration_unverified` | Isolation could not be established; do not override the existing context/policy. |
| `host_timeout` / `host_*_limit_exceeded` / `host_spawn_failed` | Bounded host process failed; no automatic retry. |
| `probe_assertion_failed` | Review failed assertion names and fixed transport counters; a marker alone is insufficient. |
| `probe_execution_failed` / `probe_cleanup_failed` | Local setup, receipt/storage or cleanup failure; no successful verification claim. |

The public report omits raw prompts, tool results, credentials and temporary
paths. Tests use synthetic data. See the [dated validation](VALIDATION-CLAUDE-LOCAL-LOOP.md)
and [pairing trust/upgrade limits](CLAUDE-HOOK-PAIRING.md). Default profiles,
concurrency, cancellation, subagents, resume/restart and real-model behavior
remain separate acceptance gates.
