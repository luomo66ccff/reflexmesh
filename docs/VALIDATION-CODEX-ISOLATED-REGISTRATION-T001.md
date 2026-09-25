# Codex isolated registration/readback — local validation t001

Date: 2026-09-25. Scope: close the gap between a syntactically valid Codex
configuration preview and an actual installed-CLI `mcp add`/`list`/`get` round
trip, without installing anything in the user's Codex profile.

## Behavior and boundary

- The default `compat:codex-setup` remains account-free and CLI-free. It still
  checks two production MCP processes, two decisions, one model-reported
  unknown outcome, zero labels, same-call restart replay and changed-task
  conflict.
- With an explicit `--codex-executable ABS`, the probe makes a new disposable
  `CODEX_HOME` and redirects HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG
  locations there as fallback fences. The selected installed CLI first lists
  no default row. The probe then runs the doctor's generated `mcp add`
  arguments in that isolated environment. A second doctor list must report
  `matching_config`, with no new add command; CLI `mcp get --json` must read
  back the exact STDIO command, arguments and abstain-only environment.
- The ledger must still be absent after registration. The normal synthetic MCP
  evidence exercise then runs, and the owned temporary directory is checked
  before recursive cleanup. The probe neither starts a Codex Agent nor calls a
  model. It does not install a row in the user's live profile.

## Local evidence

- Installed Codex CLI `0.155.0-alpha.16.4` returned
  `nativeCodexConfig=parsed_by_installed_cli` and
  `nativeCodexRegistration=isolated_add_list_matching`. The production MCP
  report retained two decisions, one model-reported unknown outcome, zero
  labels, restart reuse and changed-task rejection.
- A repeat check compared the ordinary user `config.toml` before and after the
  isolated probe; its SHA-256 was unchanged. This is not a claim that every
  Codex-owned file was observed.
- `npm ci --ignore-scripts`, `npm run check` and `npm run demo` passed locally
  on Node 24.19.0 / SQLite 3.53.3. The final full suite reported **976 tests:
  974 passed, zero failed, two local Windows symlink-privilege skips**. A
  hermetic four-command fixture verifies the absent/add/matching/get sequence
  and temporary HOME/USERPROFILE/TEMP settings in offline CI; its focused
  setup-probe test passed 4/4. The installed-CLI run is separate. Remote
  PR/main CI remains a separate readback.

## Open limits

The temporary registration tests this installed CLI version, not a running
default-profile Codex session or another platform/version. `mcp list` and
`mcp get` do not prove that an Agent selected ReflexMesh, that a native tool
was observed, or that model-reported outcomes are host truth. No real user
profile was modified; actual installation still requires an explicit manual
choice. This milestone does not close the broader host lifecycle or product
quality gates.
