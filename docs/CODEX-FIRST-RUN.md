# Codex: reviewable first connection

ReflexMesh's Codex endpoint is an advisory STDIO MCP server. It records a
decision about a **model-reported** call and can attach a model-reported
outcome; it does not intercept Codex's native shell or file tools, grant
permissions, execute tools, or prove that a reported outcome happened.
Start with the account-free [first-run lesson](../README.md#run-the-current-branch)
if you have not yet seen the decision/outcome distinction.

## Generate a configuration you can review

From the ReflexMesh repository root, use a Node release whose SQLite includes
the required WAL-reset fix. The doctor does not upgrade Node or create a
database. Get the exact Node executable path with `node -p "process.execPath"`,
then pass that path, a **new or already-owned local** ledger path, and explicit
tenant/scope identifiers:

```powershell
npm ci --ignore-scripts
npm run build
npm run doctor:codex -- --node-executable "C:\path\to\node.exe" --db "C:\private\reflexmesh\shadow.sqlite" --tenant local --scope my-project
```

Use `--json` for a bounded machine-readable report. If the database already
exists, `--key KEY_FROM_EVIDENCE_LIST` asks for one historical record; otherwise
the doctor may show the first key-order record, **not** the latest activity.
It never uses that history as proof of the present Codex configuration. The
doctor checks explicit paths, the current Node/SQLite write gate, the build,
and optional read-only ledger history. It does not inspect your Codex profile,
read a provider key, run Codex, call a model, or write settings or a database.
If WAL side files exist or cannot be ruled out, historical inspection is
skipped. Otherwise the doctor uses an immutable read-only SQLite view and
discards the result if file metadata or side-file state changes. This is a
bounded historical snapshot, not proof that another process made no changes
during the check; do not use it to certify a live ledger.

The output contains a TOML snippet for a Codex `mcp_servers` entry. Review
its absolute `command`/`args`, private `REFLEXMESH_DB`, `REFLEXMESH_TENANT`
and `REFLEXMESH_SCOPE` before manually merging it into your own Codex
configuration. It deliberately pins `REFLEXMESH_PROVIDER=abstain`,
`REFLEXMESH_ALLOW_REMOTE=false`, and `REFLEXMESH_TASK_EVIDENCE=true`.
Do not paste it over an existing server row or assume a newly edited config
has been loaded by a running Codex session. [OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
describes the `mcp_servers` STDIO `command`, `args`, `env` and `cwd` fields;
`codex mcp list` checks registration, not a tool call or model behavior.

## Verify the setup without an account

```powershell
npm run compat:codex-setup
# Optional installed Codex CLI parser check, with an explicit executable:
npm run compat:codex-setup -- --codex-executable "C:\path\to\codex.exe"
```

The first command uses the generated settings in a new temporary directory
to launch the **production** MCP server twice. It sends fixed synthetic
`initialize`/`tools/list`, a missing-task assessment, a model-reported task
assessment and an explicitly `unknown` model-reported outcome, then reopens
the ledger to check that those facts and zero labels persisted. The provider
is `abstain`; no model, real Codex Agent or host tool runs. Its temporary
ledger is removed after the check. The optional CLI check asks the installed
Codex executable to parse equivalent generated config fields via read-only
overrides; it does not install the server. Codex may still read its existing
local config during that parser check, so omit the option if you do not want
that access. Neither check changes your user configuration.

If you later opt in to an actual Codex Agent call, record that result
separately. The MCP server's `reflexmesh_assess` input needs an explicit
`call` identity; optional `userIntent` is a model-reported summary, not an
authenticated user prompt or verified capture time. `reflexmesh_observe_outcome`
records a model report, not observed execution. Use the read-only
[evidence CLI](EVIDENCE.md) to inspect the resulting ledger. Missing reports
are not proof that a native tool did not run, and an `unknown` outcome is never
an automatic retry permission.
