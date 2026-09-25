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
and optional read-only ledger history. By default it does not inspect your
Codex profile, read a provider key, run Codex, call a model, or write settings
or a database. The separate explicit `--codex-executable` option below only
invokes the CLI's registration-list subcommand.
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

### Optional: check the current registration before a copyable add command

If you explicitly provide an installed Codex CLI path, the doctor invokes only
that binary's `mcp list --json` subcommand and reduces its output to a fixed
same-name status. The raw list, including any existing environment values, is
not printed. On Windows, get the CLI path with `(Get-Command codex).Source`:

```powershell
npm run doctor:codex -- --node-executable "C:\path\to\node.exe" --codex-executable "C:\path\to\codex.exe" --db "C:\private\reflexmesh\shadow.sqlite" --tenant local --scope my-project
```

When the default `reflexmesh-shadow` name is absent and all prerequisites pass,
the doctor prints a PowerShell or POSIX `codex mcp add` command using the exact
reviewed environment and the same absolute Codex executable it inspected,
not a potentially different CLI from `PATH`. **It never runs that command.** Running it yourself
changes your personal Codex configuration; first review the paths, identifiers
and existing rows with `codex mcp list`. The check only searches that one name,
so another row could already point to ReflexMesh. A matching same-name row
needs no add; a differing row is a conflict and no add command is printed.
Unparseable, excessive or failed CLI output is a fixed failure, not permission
to overwrite. Names and paths with unusual literal double quotes retain the
TOML fallback instead of an unverified native-shell command.

The optional check reads the current CLI profile and may encounter private
settings; omit it if you do not want that access. It does not call a model or
MCP tool, create the database, or prove that an already-running Codex session
loaded the entry. After a manual add, use `codex mcp list` and start a fresh
Codex session before an opt-in Agent check. Protect the doctor output: even
without secrets, paths, tenant and scope can be sensitive metadata.

## Verify the setup without an account

```powershell
npm run compat:codex-setup
# Optional installed Codex CLI parser check, with an explicit executable:
npm run compat:codex-setup -- --codex-executable "C:\path\to\codex.exe"
```

The first command uses the generated settings in a new temporary directory
to launch the **production** MCP server twice. It sends fixed synthetic
`initialize`/`tools/list`, a missing-task assessment, a model-reported task
assessment and an explicitly `unknown` model-reported outcome. After the first
server exits, the second process repeats the same call and summary: it must
reuse the persisted decision without another row. A changed summary under the
same call identity must return a fixed contract conflict; a genuinely new task
needs a new call ID. The reopened ledger must still have only two decisions,
one model-reported unknown outcome and zero labels. The provider is `abstain`;
no model, real Codex Agent or host tool runs. Its temporary ledger is removed
after the check. The optional CLI check asks the installed
Codex executable to parse equivalent generated config fields via read-only
overrides; it does not install the server. Codex may still read its existing
local config during that parser check, so omit the option if you do not want
that access. Neither check changes your user configuration.

This verifies one production MCP process-restart/idempotency boundary with
synthetic input. It does not demonstrate that the Codex Agent itself resumed a
session, retried a native tool, or authenticated the model-reported call ID.

## Optional logged-in Agent check

The next check is **not** part of the account-free setup probe. It invokes
your logged-in Codex CLI and may use multiple underlying model requests;
neither the request count nor account cost is capped by ReflexMesh. Run it
only with an explicit `--execute` and a native Codex executable path:

```powershell
npm run compat:codex-agent -- --help
npm run compat:codex-agent -- --execute --codex-executable "C:\path\to\codex.exe" --out-dir "C:\private\new-codex-evidence" --json
```

The output directory must not exist beforehand. Omit `--out-dir` for an
automatically removed temporary test. The probe gives the Agent one synthetic
task and a new fixture whose random contents are not included in its prompt.
It checks typed Codex events for advisory assessment, one native read and a
separate model-reported outcome, then checks the production ledger through the
public read-only evidence CLI. An explicit output directory retains the
synthetic ledger and a `START-HERE.md` with copyable inspection commands;
neither raw Codex JSONL nor tool output is written into the repository.
Do not rerun automatically if the host/model call fails or times out; first
inspect the fixed failure reason and, if you chose `--out-dir`, the retained
synthetic directory. A failed run may not have produced a complete ledger.

The probe does not edit `config.toml`; it uses generated settings as one-run
overrides. `--ignore-user-config` does not disable existing Codex login,
and `--ephemeral` only avoids session rollout persistence. A read-only sandbox
does not prove that the Agent could not read other local files. Run this only
in a trusted local environment with a synthetic, non-sensitive fixture.
Codex's own prompt/tool data can leave the machine even though the ReflexMesh
decision provider is pinned to `abstain` with remote egress disabled. The
model-supplied call identity is not authenticated host identity, and the
outcome remains model-reported even if a separate Codex command event matches.
See [OpenAI's non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
for the CLI flags and JSONL event boundary.

The MCP server's `reflexmesh_assess` input needs an explicit
`call` identity; optional `userIntent` is a model-reported summary, not an
authenticated user prompt or verified capture time. `reflexmesh_observe_outcome`
records a model report, not observed execution. Use the read-only
[evidence CLI](EVIDENCE.md) to inspect the resulting ledger. Missing reports
are not proof that a native tool did not run, and an `unknown` outcome is never
an automatic retry permission.
