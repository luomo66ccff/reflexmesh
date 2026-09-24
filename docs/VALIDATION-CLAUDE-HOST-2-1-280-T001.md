# Claude Code 2.1.280 isolated-host validation t001

Date: 2026-09-24. Scope: account-free Windows installed-CLI compatibility
against a private synthetic localhost Messages fixture. This records local
evidence only; remote CI and publication are separate checks.

## Version drift and correction

The installed CLI reported `2.1.280 (Claude Code)`. Before this change,
`compat:claude-local` returned `unsupported_host_version` because probes were
pinned only to 2.1.263. Exact version dispatch now retains 2.1.263 and admits
2.1.280; nearby revisions and altered product labels still fail closed.

The interrupted cold-resume shape changed. The 2.1.263 fixture expected the
unfinished tool call to be absent from resumed Messages and a fixed assistant
placeholder to follow. The observed 2.1.280 request retains that tool call,
inserts an `is_error: true` tool result with the exact text
`[Request interrupted by user for tool use]`, and then the placeholder.
The verifier accepts that shape only for 2.1.280, requires exact call/result
identity and ordering, and does not turn the injected error into a returned
tool result or a ReflexMesh host observation. Negative tests reject missing,
altered, successful, duplicated and cross-version shapes.

## Local checks

- `compat:claude-local`: native Read and duplicate-observer scenarios,
  **22/22 assertions each**.
- `compat:claude-setup`: generated production hooks with default capture off
  and explicit-summary opt-in, **17/17 assertions each**.
- `compat:claude-failure`: overlapping fixed synthetic MCP success/failure
  and direct production hooks, **19/19 assertions**.
- `compat:claude-resume`: clean exit and entered-then-killed cold resume,
  **20/20 assertions each**. The killed old call kept zero observed outcomes;
  the new call used a different ID, and the fixture saw no old retry.
- Focused version, local, setup, mixed-outcome and resume unit suites:
  **168/168 passed** on Node 24.19.0.
- `npm ci --ignore-scripts --no-audit --no-fund` and `npm run demo` passed.
  Full `npm run check`: **828 tests, 826 passed, zero failed, two local
  Windows symlink-privilege skips** on Node 24.19.0.

These checks use separate temporary Claude/Anthropic/plugin stores and a
synthetic token routed only to localhost. They do not use the default profile,
real inference, an account or a paid API. No user session or credential is
read or changed. Windows process-tree termination remains best-effort for
descendants; the probe requires an owned direct-child close receipt.

## Open boundary

The historical 2.1.263 installed-host validation was not rerun in this
increment; its strict shape and unit tests remain. This does not certify
default-profile operation, arbitrary host revisions, actual cancellation
hooks, unattended continuation, forked agents, remote side effects or
production hook latency. A green synthetic probe is not general host support.
