# Codex first connection: local validation t001

Date: 2026-09-25. Scope: the local candidate before PR #55 merged; the remote
[integration readback](VALIDATION-CODEX-FIRST-RUN-INTEGRATION-T001.md) is separate. This report is not
evidence of a current Codex profile, an actual Agent decision, a model call,
or host-native tool execution.

## Change and safety boundary

- `doctor:codex` checks explicit Node, database, tenant and scope inputs and
  emits a manually reviewable `mcp_servers` TOML fragment. It does not edit
  Codex settings, acquire credentials, start Codex or create a database.
- The generated environment pins `REFLEXMESH_PROVIDER=abstain`, disables remote
  calls and enables explicit model-reported task evidence. It remains an
  advisory shadow MCP connection, not a host permission boundary.
- For an existing ledger, the doctor skips historical inspection when WAL
  side files exist or their absence cannot be confirmed. Otherwise it opens
  an immutable read-only SQLite view and discards output if file metadata or
  side-file state changes. Metadata comparison cannot prove that no concurrent
  update occurred; history is never current host attestation.
- `compat:codex-setup` uses a new temporary ledger and two production MCP
  processes with fixed synthetic requests; it checks persisted decisions,
  explicitly UNKNOWN model-reported outcome and zero labels. Temporary probe
  data is removed. The optional CLI step uses read-only config overrides to
  parse equivalent generated fields; it does not install the server.

## Local evidence

- `npm ci --ignore-scripts`: passed with zero reported vulnerabilities.
- `node --test test/codex-setup.test.mjs test/codex-doctor.test.mjs
  test/codex-setup-probe.test.mjs`: 15 passed, zero failed.
- `npm run check`: typecheck and build passed; 895 tests, 893 passed, zero
  failed, two local Windows symlink-privilege skips.
- `npm run demo`: passed. Its output is synthetic, not a live Codex result.
- `npm run compat:codex-setup -- --codex-executable
  'C:\Users\luomo0712\AppData\Local\OpenAI\Codex\bin\13995fba801849b0\codex.exe' --json`:
  passed. Reported `nativeCodexConfig=parsed_by_installed_cli`, two MCP
  processes, four listed tools, two decisions, `outcomeStatus=unknown`,
  `outcomeProvenance=model-reported`, zero labels, `actualCodexAgent=not_tested`
  and `modelRequest=none`. The installed CLI reported version
  `codex-cli 0.155.0-alpha.16.4` in a separate read-only check.
- A doctor invocation with a new temporary database path reported
  `database=not_created` and `liveHost=live_host_unverified`; the target file
  remained absent.

## Remaining acceptance

Manual profile merge, a real Codex Agent/model call, default-profile behavior,
user comprehension, cross-host cancellation/concurrency and representative
quality remain untested or open. This validation does not claim bug-free scope.
