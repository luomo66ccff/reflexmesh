# Codex registration preview — local validation t001

Date: 2026-09-25. Scope: a reviewable Codex CLI registration path, without writing the user's Codex configuration. This does not prove default-profile installation or a live Agent tool call.

## Behavior

- The existing first-run doctor still defaults to no Codex CLI/profile access and no settings or database write.
- An explicit `--codex-executable ABS` invokes only that binary's `mcp list --json`, with a 30-second timeout and 256 KiB output cap. It reduces the result to same-name `not_registered`, `matching_config`, `different_config` or fixed unavailable states; raw current rows, environment values and stderr are not returned.
- Only an absent `reflexmesh-shadow` row with ready prerequisites exposes a copyable `codex mcp add` command in text/JSON. Matching and conflicting rows, unchecked profiles and prerequisite failures do not expose that command. The command is never executed by the doctor. It pins the exact inspected Codex executable rather than resolving a different `codex` from `PATH`, as well as the existing abstain/shadow environment and explicit Node, ledger, tenant and scope. Literal double-quote values keep the TOML fallback because native shell passing was not verified for those values.
- The optional check only compares the default row name and recommended STDIO fields. Another name could point to ReflexMesh, and matching configuration does not prove a running Codex session loaded it or that an Agent called the tools.

## Evidence

- Installed local Codex CLI reported `codex-cli 0.155.0-alpha.16.4`; its `mcp add --help` showed repeatable `--env` and `-- COMMAND` syntax. The optional doctor check against this installed CLI returned `prerequisites_ready`, `not_registered`, and a generated command bound to that executable. The generated PowerShell command parsed as one statement with zero errors. The selected synthetic database path was not created. The local `config.toml` SHA-256 before and after the check was identical; this is a check of that file, not a guarantee about every host-owned file.
- `npm run compat:codex-setup -- --codex-executable ABS` passed the installed parser and two-process synthetic production MCP probe: two decisions, one model-reported unknown outcome, zero labels, same-call restart reuse and changed-task conflict. It did not call a real Agent/model/tool.
- Unit tests cover absent, matching, conflicting, extra inherited environment, malformed/excessive list output, unsafe executable path, shell quoting, no raw-value echo and no database creation.
- `npm ci --ignore-scripts`, `npm run check` and `npm run demo` passed on the local Node 24.19.0 / SQLite 3.53.3 environment. The final full check reported **975 tests: 973 passed, 0 failed, 2 skipped** for local Windows symlink privileges. A focused rerun of the Codex setup/doctor tests passed 15/15.

## Open limits

No generated `codex mcp add` command was executed against the user's profile. No live default-profile loading, Agent selection, host authorization, real-model quality, or cross-version Codex CLI acceptance is claimed. The CLI subcommand is treated as read-only configuration inspection; its own implementation is external to ReflexMesh. For a manual install, review the command, existing names and private paths, then verify registration and start a fresh Codex session.
