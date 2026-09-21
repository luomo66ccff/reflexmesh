# SQLite runtime: API floor is not WAL write readiness

Before connecting a persistent ledger, run the exact Node binary that will run
the adapters (no build, credentials or ledger required):

```bash
node adapters/runtime-cli.mjs
node adapters/runtime-cli.mjs --json
```

Exit 0 means this process passed the known WAL-reset version gate; exit 1 means
blocked/unknown; exit 2 is invalid arguments. This opens and closes a separate
`:memory:` database and reads `sqlite_version()`. No requested user database,
settings, credentials, host or model is accessed. Both first-run doctors include
the same result under `prerequisites.sqliteRuntime`; a blocked write gate is an
action diagnostic, not a corrupt-database diagnosis.

## Requirement

`engines.node >=22.16` is the API floor, **not sufficient for persistent WAL
writes**. Node 22.16.0 bundles SQLite 3.49.1. SQLite's upstream WAL-reset fix is
present in 3.51.3 and later 3.x releases, with branch-specific backports at
3.44.6+ and 3.50.7+. Intervening branches are not covered by the older backport.
Unrecognized/malformed versions, future major versions, failed probes and
missing SQLite APIs fail the persistent write gate.

Sources: [SQLite WAL-reset notice](https://www.sqlite.org/wal.html#the_wal_reset_bug)
and [Node 22.16.0 bundled SQLite header](https://github.com/nodejs/node/blob/v22.16.0/deps/sqlite/sqlite3.h#L143).
This guard addresses the known upstream race, not all SQLite defects. A
version string does not authenticate a custom build or attest its patch set.

`SqliteKernel` rejects file-backed writable opens before file creation/open,
WAL configuration or schema migration. Local boundary and DeepSeek Loader
entrypoints also check before creating a ledger directory. There is no event,
environment or constructor bypass. The schema, UNKNOWN tombstones, pairing
guards, labels and execution permissions do not change.

Read-only schema 1/2/3 inspection remains available if the API and database can
be read; it never migrates a ledger. SQLite may still maintain WAL/SHM metadata
on a read-only open, so this is not filesystem immutability or an endorsement
of simultaneous old writers. In-memory kernels and the separate DELETE-journal
IntentCache are outside this WAL write gate. Claude shadow hook failures keep
their empty response and do not change native host permission decisions.

## Choose a runtime manually

1. Select an official Node build containing a fixed SQLite. Local validation
   uses Node 22.23.2 / SQLite 3.51.3 and Node 24.19.0 / SQLite 3.53.3;
   these are tested combinations, not a claim about every Node 22/24 build.
2. Run this preflight using that explicit executable. Stop old ledger workers
   and restart all ledger adapters with it; changing this checkout cannot fence
   an already-running old process. Do not kill unrelated applications.
3. Regenerate/review hook settings if their absolute Node path changed. Run the
   appropriate first-run doctor and your isolated host validation again.

No automatic global install, PATH change, provider fallback, retry or database
repair is performed. Readiness for this process does not prove other processes
use it. It does not prove an old ledger is intact or undo prior corruption. Keep
consistent backups and follow the [recovery boundaries](RECOVERY.md); do not
copy only the main file of an active WAL ledger or replace a current ledger with
an old snapshot that could lose admission tombstones.
