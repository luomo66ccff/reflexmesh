# Retained synthetic first-run lesson validation t003

Date: 2026-09-24 (Asia/Shanghai). Windows, Node.js 24.19.0, npm 11.17.0,
SQLite 3.53.3. Branch `feat/first-run-retained-lesson`, based on public main
`ccbd348d44b4247313cb1edefe531546a9d2cf39`. This is local evidence for this
increment only; remote CI must be checked against the exact submitted head.

## Verified

- `npm ci --ignore-scripts`: passed before implementation; this increment adds
  no dependency or lockfile change.
- `npm run check`: **816 tests, 814 passed, zero failed, two expected Windows
  skips** (local symlink creation unavailable; recovery symlink input is skipped
  on Windows). This includes five first-run regressions and a nested
  `npm run first-run -- --out-dir "... Unicode and spaced path ..."` process.
- `npm run demo`: passed.
- `npm run demo:evidence`: passed with the original detailed walkthrough; the
  temporary ledger and summary cache were removed.
- `npm run first-run`: passed the actual in-memory SQLite WAL-write preflight,
  built the project, produced one fixture prediction, and reported three
  synthetic decisions and zero labels.
- The retained-output test checks new-directory-only creation, Unix private
  modes where available, absence of raw summary text in the ledger/output,
  zero labels, read-only `list` / `attention` / `inspect` behavior, exact main
  ledger bytes after inspection, and preservation of an existing target.
- `git diff --check`: passed.

## Boundaries

The lesson uses a fixed `MockProvider` and fixture outcome only. It does not load
provider environment configuration, access user profiles or credentials, call
a real model, start a host, or execute a host tool. Retained output consists of
the synthetic `ledger.sqlite` and `START-HERE.md`; raw task-summary text lives
only in a separately created temporary cache that is removed after close.
SQLite read-only inspection may create or interact with WAL/SHM sidecars, so
this does not claim byte-for-byte filesystem immutability.

No Linux or Node 22 local run was performed for this increment. Cross-platform
CI, installed-host compatibility, real-model quality, production load/privacy,
and the project's broader lifecycle, provider-quality and recovery gates remain
separate and open. This does not establish that the project has no bugs.
