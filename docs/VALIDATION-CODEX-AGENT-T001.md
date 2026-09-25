# Codex Agent first-evidence validation t001

Date: 2026-09-25. Scope: one opt-in, installed, logged-in Codex CLI Agent
session against a fresh synthetic local fixture. This is not a default-profile
installation or general Codex compatibility certificate.

## Result

`npm run compat:codex-agent -- --execute --codex-executable ABS --out-dir NEW_ABS --json`
passed on Windows with Codex CLI `0.155.0-alpha.16.4` and Node `24.19.0`.
The bounded receipt reported one Agent invocation attempt, one completed Agent
invocation, one native read, two ReflexMesh MCP calls, no ReflexMesh provider
egress, one ready task with model-reported provenance, one model-reported
succeeded outcome, zero labels, and matching public `list`/`inspect` with
empty `attention`. The exact underlying model request count and account cost
were not measured. The retained `t007` synthetic directory contains only the
fixture, SQLite ledger/WAL/SHM and `START-HERE.md`; it contains no raw JSONL.

The validator requires ordered typed JSONL starts and completions for
`reflexmesh_assess`, one Codex `command_execution`, and
`reflexmesh_observe_outcome`, with matching call arguments and IDs. The native
command must be a single `Get-Content -LiteralPath` of the newly created
fixture, directly or through a narrowly recognized Windows PowerShell wrapper;
its resolved path must match the fixture, exit code must be zero, and output
must equal the random marker that was not placed in the prompt. The public
evidence CLI and a separate read-only SQLite snapshot must agree. Unknown,
failed, duplicate or extra tool events fail closed; model prose cannot stand
in for tool evidence.

The first six retained synthetic attempts were not reported as passes.
`t001` had an incomplete typed sequence and only an assessment in the ledger.
`t002` through `t006` showed the expected assessment, successful native marker
read and model-reported outcome, but the original byte-for-byte command
matcher did not recognize Codex's Windows PowerShell launch wrapper and
equivalent fixture paths. The matcher was narrowed to a single parsed read of
the same fixture, and tests cover wrapper forms, relative paths, extra
commands, unexpected executables and paths outside the fixture. `t007` is the
first accepted real-Agent run. Earlier failed receipts and directories were
preserved, not rewritten or counted as passes.

`npm ci --ignore-scripts` succeeded with zero reported vulnerabilities. The
final `npm run check` completed 905 tests: 903 passed, zero failed, two local
Windows symlink-privilege skips. `npm run demo` passed. The focused Agent
probe suite passed 10/10 after the final matcher change.

## Evidence boundary

The separate Codex command event and exact synthetic output corroborate a
native read in this one session, but the ReflexMesh outcome remains
`model-reported`, not host-authenticated. The MCP call identity is supplied by
the Agent, and the advisory shadow decision neither grants nor denies a host
action. A read-only sandbox and isolated fixture do not prove complete local
read isolation. No user Codex configuration, credentials, real files, provider
keys, or production ledgers were changed by the probe. The configured decision
provider was `abstain`; the logged-in Codex Agent itself used its model service.
Default-profile installation, cancellation, restart, subagent behavior and
broader host coverage remain unverified.

See the [first-run guide](CODEX-FIRST-RUN.md) for the opt-in command and
[OpenAI's non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
for CLI JSONL and ephemeral execution semantics.
