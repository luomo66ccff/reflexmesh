# Storage diagnostics validation — t001

Date: 2026-09-22 (Asia/Shanghai). Base: PR #16's
`d6c23c439093da984b5a6e55d2a94dc5e7888dd7`, not merged main. The implementation
is committed as `b1a42a9b1b5e54a6ddb8bb6ea2c5fb406a198ec9`; the following
validation/state update changes documentation only. No existing PR is merged
or retargeted. Published exact-head CI is checked separately from local tests.

## Verified locally

Windows Node **22.23.2** and **24.19.0**:

- `npm ci --ignore-scripts --no-audit --no-fund` succeeded.
- Final `npm run check`: **699 tests, 698 passed, zero failed, one expected
  existing Windows symlink skip** per version.
- All **23 new focused tests** passed, no skips. Root reran them on clean
  `b1a42a9` and read back the persisted synthetic ledger through the public CLI.
- All **six offline demos** passed on both versions: `demo`, `demo:durable`,
  `demo:recovery`, `demo:evidence`, `demo:comparison`, `demo:storage`.
- The six-demo matrix is included in Ubuntu/Node 22 and Windows/Node 22/24 CI;
  no model credentials or paid calls are added to CI.

The default demo is temporary; the explicit new-directory demo retains a
synthetic ledger with three runs, six audit rows, one recovery review and one
pending pair-only guard. Public CLI readback showed one admitted, one completed
and one reviewed UNKNOWN run. No tool or model ran. These are actual SQLite/
process checks over synthetic records, not a real user-ledger or host test.

## Regression evidence

| Boundary | Evidence |
| --- | --- |
| Schema 1/2/3 | Historical fixture reads preserve user_version and application-row hashes; unsupported tables have null coverage, no migration |
| No body/identity disclosure | Output excludes keys/tokens/digests and selected private evidence/result/audit/label/review sentinels; SQL projects fixed metadata only |
| Retention safety | Complete application rows stay unchanged; completed claims still replay, UNKNOWN stays unknown and active admission remains busy |
| Bounded samples | Each fixed table has at most limit plus lookahead; truncation means null total; state/pair-only counts exclude lookahead |
| SQL snapshot | A controlled second connection commits between table scans; the first report retains its original cohort and the next sees the new run/audit |
| Error recovery | An injected invalid projection rolls back the read transaction; the same reader works afterward and row hashes stay unchanged |
| File metadata | Present/zero/missing/nonregular/unavailable and unsafe numeric lengths remain distinct; injected permission/IO failures do not become zero bytes |
| Public command | Spawned JSON/human CLI, destructive-looking flag rejection, no missing-DB creation, redacted errors and body-free output |
| Onboarding | New-only retained demo, owned-temp cleanup and process-level space/Chinese-character path handling |

The two-connection test is a controlled overlapping transaction test, not a
cross-host stress/load certification. Permission/IO and symbolic-link metadata
branches use controlled injections where noted; they do not prove Windows ACL
enforcement or race-free SQLite sidecar handling. The root separately inspected
the unchanged admission/idempotency methods in the diff.

Scoped independent read-only review found no reproducible P1/P2 in the new
file/report/CLI/core boundaries. Root inspected the implementation, ran the
focused/full suites and read back actual command output before accepting it.
This is not an external security audit or proof of absence of all bugs.

## Windows argument-forwarding finding

A manual `npm run demo:storage -- --out-dir ...` with a space-containing
absolute path failed on the tested PowerShell/npm **11.17.0** invocation;
the requested directory was not created. The no-argument npm demo passed.
The same path succeeded through `node examples/storage-diagnostics.mjs`
directly. Help/docs now give that direct quoted-path form; process regressions
cover spaces and Chinese characters, and split/extra arguments fail without
echoing private input. This does **not** claim npm's own quoting was repaired.

Initial failure and successful direct/final-demo logs are retained separately
under operator-local `tmp/reflexmesh-storage-validation-t001/`, alongside final
Node 22/24 checks, clean-head focused log, JSON readback and `lesson/` synthetic
ledger. No real user database, credentials or production records were uploaded.

## Deliberately unverified / not implemented

- No deletion, retention-policy application, VACUUM, checkpoint, compression,
  backup/restore, authenticated review, automatic retry or space reclamation.
- Read-only SQL does not guarantee byte-for-byte filesystem immutability; WAL
  readers can interact with sidecars. File observations and SQL snapshot are
  not atomic, and metadata `lstat` does not attest SQLite's earlier file access.
- No age eligibility from lease/key/audit order, per-table byte attribution,
  arbitrary-database wall-clock bound, integrity certification or full schema
  validation. Counts/sizes can themselves be sensitive.
- No new paid model/real-host/default-profile validation this increment. Host,
  independent-provider quality, privacy/load and safe reclaim/restore gates
  remain open in [iteration state](ITERATION-STATE.md).

See [usage and exact limits](STORAGE-DIAGNOSTICS.md).
