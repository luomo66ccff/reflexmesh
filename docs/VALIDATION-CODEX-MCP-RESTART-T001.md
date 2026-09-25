# Codex production MCP process-restart validation — t001

Date: 2026-09-25. Local Windows, Node.js 24.19.0 / SQLite 3.53.3, installed
Codex CLI 0.155.0-alpha.16.4. The probe uses a new temporary ledger,
generated one-run MCP settings and the `abstain` decision provider. No Agent,
model, account request, native tool or user-profile write is involved.

## Product boundary exercised

The existing setup probe starts the production STDIO MCP server twice. The
first process records a missing-task decision, a model-reported task decision
and one separately model-reported `unknown` outcome. The new second-process
check sends the **same** call identity and summary to `reflexmesh_assess` and
requires `replayed: true`, the original decision ID and the original shadow
verdict. It then changes the summary without changing call identity and
requires the fixed contract-conflict response, not a new decision. A second
readback verifies exactly two decisions, one unknown model-reported outcome
and zero labels. The temporary directory is removed after the ledger closes.

This tests durable same-call behavior across a server process restart, not
Codex Agent session recovery or a retry of a native tool. Model-reported
identity and outcome remain model-reported; a new task needs a new call ID.

## Local evidence

- `npm ci --ignore-scripts`: passed; local audit found zero vulnerabilities.
- `node --test test/codex-setup-probe.test.mjs`: 3/3 passed.
- `npm run compat:codex-setup -- --json`: passed with `processCount: 2`,
  `restartReplay: true`, `restartConflictRejected: true`, two decisions,
  one unknown model-reported outcome and zero labels.
- The same probe with explicit installed Codex CLI executable returned
  `nativeCodexConfig: parsed_by_installed_cli`. This parser check may read
  existing local config but did not change it or run a model.
- The installed-host DeepSeek `lifecycle-matrix` probe passed all 17 synthetic
  assertions against the current 0.1.2-rc.1 installation.
  This is independent host evidence, not part of the Codex restart claim.
- `npm run check`: 935 tests, 933 passed, 0 failed, two local Windows
  symlink-privilege skips; typecheck/build passed. `npm run demo`: passed.
- `git diff --check`: no whitespace errors; Git reported Windows CRLF
  conversion warnings only.

Remote exact-head PR CI and post-merge main CI must be verified separately.
Unfinished: real Codex Agent resume, default-profile installation, authenticated
host call identity, native-tool cancellation/restart and broader cross-host
lifecycle matrix. Nothing here grants execution or retry permission.
