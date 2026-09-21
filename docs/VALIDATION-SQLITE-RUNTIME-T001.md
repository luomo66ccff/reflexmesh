# SQLite runtime preflight validation t001 — 2026-09-22

Scope: `fix/sqlite-runtime-preflight`, based on storage PR #17's `09bd885`.
This is a stacked increment, not merged main. Check the published exact head's
own CI; historical green jobs do not validate this patch.

## Verified locally on Windows

- Node 24.19.0 / SQLite 3.53.3 and portable Node 22.23.2 / SQLite 3.51.3:
  `npm run check` each completed **707 tests, 706 passed, zero failed, one
  existing expected Windows symlink skip**. All six offline demos passed on
  both runtimes: default, durable, recovery, evidence, comparison and storage.
- Eight new offline tests cover strict branch-specific fix classification,
  actual in-memory metadata, malformed/failed probe redaction and closure,
  reject-before-create/migration, preserved read-only/in-memory paths, doctor
  action diagnostics with historical inspection, bounded CLI options and
  help without probing. Scoped independent review found no reproducible P1/P2;
  root checked implementation and live results.
- Both doctor suites were rerun on each supported runtime after tightening the
  unbuilt-copy assertion to allow only the exact optional SQLite experimental
  warning on stderr. **26/26 passed** each. No arbitrary startup errors are
  hidden. The doctor source imports no built application code to report a
  missing build.
- Official portable Node **22.16.0 / SQLite 3.49.1** was downloaded to an owned
  validation directory and checked against Node's official `SHASUMS256.txt`.
  No system Node, PATH, profiles or application settings were changed.
  `node scripts/sqlite-runtime-negative.mjs` passed **11 scenario groups**:
  absent ledger, existing synthetic schema-1 marker database byte preservation,
  read-only open, in-memory kernel, local-boundary no directory creation,
  Loader no directory creation, runtime CLI rejection, both doctor diagnostics,
  and both production Claude CLI empty-response paths. The hook payload is
  validated with the production mapper first; these are process regressions,
  not actual Claude-host permission enforcement tests.

The old-runtime script only accepts pinned Node 22.16.0 and verifies its actual
SQLite version. It creates its own temporary fixture directory and closes all
handles before bounded canonical-path cleanup. Its schema-1 marker fixture
tests the open/migration barrier, not complete historical evidence contents.
No user ledger is accepted as an argument.

## Reproduce

```bash
npm ci --ignore-scripts
node adapters/runtime-cli.mjs --json
npm run check
npm run demo
npm run demo:durable
npm run demo:recovery
npm run demo:evidence
npm run demo:comparison
npm run demo:storage
```

Build once under a suitable runtime, then run the negative script with an
explicit Node 22.16.0 executable. CI adds pinned old-runtime negative jobs on
Ubuntu and Windows, separate from supported-runtime full test/demo jobs. CI
logs the actual runtime probe, not merely the configured Node major.

## What this does not prove

The upstream WAL-reset race was **not reproduced**. We verify the version gate
and its local side-effect boundary, not absence of corruption or all SQLite
defects. Sources and manual runtime/restart guidance are in
[SQLITE-RUNTIME.md](SQLITE-RUNTIME.md).

No actual host application, real model, account, user ledger, production
backup/restore or load/privacy acceptance ran for this increment. Existing
workers are not fenced by this new code. Read-only SQLite can touch WAL/SHM
metadata; the distinct DELETE-journal task cache is not blocked. Version
strings do not authenticate custom binaries or attest all upstream patches.
Schema, permissions, labels, pairing, UNKNOWN and retry rules are unchanged.

Local receipts are under the workspace's
`tmp/reflexmesh-sqlite-runtime-validation-t001/`; they are not repository
artifacts and contain only synthetic validation and tool output.
