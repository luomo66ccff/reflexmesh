# Ledger backup validation t001

Date: 2026-09-22. Scope: `feat/ledger-backup`, based on SQLite runtime-preflight
commit `5d86e058a37d143f04df718ffaa35a125b71b160` (PR #18), not merged main.
This report records local pre-publication validation. The published PR must
independently record its exact-head CI; base CI is not evidence for this patch.

## Delivered boundary

- Explicit local-ledger backup using SQLite's Online Backup API and a pinned
  source read transaction, including committed WAL records. Only a new,
  exclusively reserved destination is normalized to standalone DELETE mode.
- Strict schema-1/2/3 structural checks, integrity/FK checks, full-file hash and
  length, bounded storage summary, and a manifest bound by a completion marker.
  No source migration, checkpoint request, repair or row modification.
- Read-only verification with raw header checks before SQLite open. An archive
  is usable only after all checks and the final removal of INCOMPLETE.
- Child-process backup/check/hash deadline and cancellation with close receipt;
  failed or unconfirmed work is never automatically retried or published.
- Account-free lesson: full seven-table comparison, isolated fixture restore,
  preserved replay/UNKNOWN/pairing guards, and an old-valid-archive counterexample
  that explicitly demonstrates missing newer UNKNOWN tombstones.

The [guide](LEDGER-BACKUP.md) documents whole unencrypted ledger contents,
trusted private local paths, publication/response-loss behavior and exclusions.
There is no production restore or retention command.

## Local results

All tests use owned synthetic fixtures; no user ledger, actual host application,
paid model request, profile modification or global Node replacement was involved.

| Windows runtime | Full `npm run check` | Offline demos |
| --- | --- | --- |
| Node 22.23.2 / SQLite 3.51.3 | 747 tests, 745 passed, 0 failed, 2 skipped | 7/7 |
| Node 24.19.0 / SQLite 3.53.3 | 747 tests, 745 passed, 0 failed, 2 skipped | 7/7 |

Both skips concern unavailable Windows symlink creation: the existing review
input test and the new backup source/reserved-target test. They are not counted
as passing symlink enforcement evidence. `npm ci --ignore-scripts`, typecheck
and build passed. The seven demos are default, durable, recovery, evidence,
comparison, storage and backup. CI now includes the seventh demo.

The 40 added tests cover strict manifests, recognized old schemas, altered
constraints/indexes, real WAL backup, a later concurrent commit excluded by the
pinned snapshot, byte/metadata tampering, extra/partial files, trailing data,
path/link rejection, publication failures, real child timeout/cancel/crash,
build-free help, redacted errors, exact file identities and the synthetic lesson.
The full suites above include these tests.

Actual portable Node 22.16.0 / SQLite 3.49.1 passed **12 affected-runtime negative
scenario groups**, including backup creation rejection before output reservation.
The same old runtime successfully verified the retained standalone archive
read-only after the Windows metadata compatibility fix below. This is not
permission to create persistent WAL ledgers with that affected runtime, nor
reproduction of the upstream SQLite corruption race.

A separate retained lesson was created in a new space/Chinese-containing path.
The source, three-file archive and isolated restored fixture remain inspectable.
The CLI and both modern runtimes also exercised quoted paths and offline verify.
Full source application rows were unchanged by backup; filesystem immutability
is not claimed because SQLite can maintain source WAL/SHM metadata.

## Defects found and fixed before publication

1. A readonly SQLite open of a WAL-header input could create sidecars before
   rejecting its journal mode. A bounded raw 20-byte header check now runs before
   any SQLite open. The regression verifies unchanged input bytes and directory.
2. A final layout check after removing INCOMPLETE could fail after publication.
   All potentially failing filesystem checks now precede that last unlink.
   Injected layout I/O failure retains INCOMPLETE; successful publication has no
   filesystem operation after its linearization point. Lost final stdout is
   separately documented as an uncertain caller outcome, not an automatic retry.
3. Actual old Windows Node verification exposed `lstat.dev=0` versus a known
   handle `fstat.dev`, plus inode values beyond Number's safe integer range.
   Header/hash/metadata comparisons now use exact BigInt identities. Only the
   cross-path/handle Windows unknown-volume field may differ; each path and
   handle must separately retain its complete before/after identity. Regressions
   reject known-volume mismatches, adjacent large inode values and independent
   path/handle mutation. The original failure receipt was retained before the
   successful real old-runtime rerun.

Scoped independent review and root verification found no remaining reproducible
P1/P2 within these boundaries. That is not proof of no possible defects.

## Evidence locations and exclusions

Local receipts: `tmp/reflexmesh-backup-validation-t001/` in the owning workspace,
outside the repository. Final full checks are `check-node22-release.log` and
`check-node24-release.log`; final demo logs end in `-node22-release.log` or
`-node24-release.log`. Old-runtime evidence is `old-runtime-negative-release.log`
and `old-runtime-readonly-verify-fixed.json`; the preceding failed verify is
retained separately. Editable synthetic artifacts are in `retained 中文 lesson/`.
Earlier intermediate logs are not substituted for the final results.

Not established: archive origin/authenticity or freshness; every retained JSON
body's semantic correctness; hostile same-user replacement/volume attestation;
power-loss or directory-fsync durability; mapped/network filesystem support;
large-ledger load/privacy acceptance; production restore, retention or space
reclamation. Reports retain `restoreAuthorized:false` and `retryAllowed:false`.
A valid older archive cannot reconcile newer admission/pairing guards or prove
that old workers and external effects have quiesced. Broader host lifecycle,
independent provider quality and default-profile onboarding gates remain open.
