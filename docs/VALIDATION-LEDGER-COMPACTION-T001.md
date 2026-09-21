# Ledger compaction validation t001

Date: 2026-09-22. Scope: `feat/ledger-retention`, based on PR #19 commit
`feee864a468ef6bae56bbac76a6a67e994f34a1d`, not merged main. Despite the working
branch name, this increment delivers **all-record compaction**, not historical
retention. Exact published-head CI must be recorded independently; this report
describes root local pre-publication checks.

## Delivered and preserved

- Build-free CLI help, explicit backup-bound read-only preview, new-only plan,
  opt-in `apply --apply --quiescent`, and local operation-receipt inspection.
- Same-connection exclusive maintenance spanning source/plan/backup validation,
  COMMIT, VACUUM, post-verification and close; no fallback unlocked operation.
- Recognized schema 1/2/3, complete explicit-column/primary-key ordered streaming
  fingerprints, exact INTEGER BigInt values and raw TEXT bytes, including invalid
  UTF-8. Integrity and FK checks; no schema migration or journal-mode conversion.
- One attempted dispatch per plan directory, unknown outcome after unconfirmed
  dispatch, and no automatic repeat/restore. Full unencrypted backup retained.
- Actual synthetic free-page reclamation with all seven logical tables retained;
  completed replay, UNKNOWN, pair-only, provenance, labels and reviews survive.

The [guide](LEDGER-COMPACTION.md) covers authorization declarations, full-backup
privacy, operation markers, lock/timeout behavior and precise exclusions.

## Local final checks

`npm ci --ignore-scripts`, build and typecheck passed. Full `npm run check`:

| Windows runtime | Result | Offline demos |
| --- | --- | --- |
| Node 22.23.2 / SQLite 3.51.3 | 777 tests, 775 passed, 0 failed, 2 skipped | 8/8 |
| Node 24.19.0 / SQLite 3.53.3 | 777 tests, 775 passed, 0 failed, 2 skipped | 8/8 |

Both skips are existing local Windows symlink-capability exclusions, not passing
symlink evidence. Thirty new compaction regressions passed **30/30** in the
focused root run and are included in both full suites. All eight account-free
demos pass: default, durable, recovery, evidence, comparison, storage, backup
and compaction. CI includes the eighth demo.

The official portable affected Node 22.16.0 / SQLite 3.49.1 passed **13 negative
scenario groups**, now including compaction apply rejection before plan/attempt
reservation or writable source open. The existing synthetic source bytes remain
unchanged by that rejected call. This does not reproduce the upstream corruption
race or authorize persistent writes with an affected SQLite build.

## Meaningful boundaries exercised

- A dedicated dummy padding table is created and discarded only during synthetic
  fixture preparation. After backup and preview, actual VACUUM reduces the
  source main-file length from **4,268,032 to 65,536 bytes**, sampled after close.
  An independent small-fixture all-row comparison verifies seven tables unchanged
  before guard probes. No ledger rows are deleted. File length is not physical
  filesystem-block allocation or secure erasure.
- Real CLI processes use space/Chinese paths. Separate competing apply processes
  yield one successful dispatch and one rejected applicant for the same plan.
- Separate OS writers receive BUSY after the initial COMMIT and before VACUUM,
  for both WAL and DELETE source modes. This validates the check-to-operation
  exclusive-lock interval, not just a same-process transaction abstraction.
- Actual process kills at pre-VACUUM and post-VACUUM barriers allow reopening and
  comparing complete logical contents. Timeout/cancel tests await owned child
  close; they do not infer a rolled-back VACUUM from a missing receipt.
- Stale source, non-equivalent or changed archive, different source path with
  identical content, source equal to archive, output inside archive/sidecar paths,
  reused/partial plan, tampered markers, invalid options and absent opt-in fail.
- Complete-marker and final-publication I/O failures after actual VACUUM preserve
  UNCONFIRMED and `apply_unknown`, even if the database has already compacted.
  Receipt inspection never certifies the current live ledger.
- Injected `SQLITE_FULL` at the VACUUM call and a post-VACUUM injected I/O failure
  both retain `compaction_uncertain`; source contents reopen intact. These are
  controlled fault injections, **not actual OS disk exhaustion or power loss**.
- Old schemas remain unmigrated; rowid-only changes do not affect the digest,
  while explicit high 64-bit integers and changed bodies/pairing reasons do.

## Defect caught during implementation

SQLite STRICT TEXT can contain malformed UTF-8 admitted via CAST from BLOB.
Distinct byte sequences `80` and `81` both decode through Node to the same
replacement character. Hashing JavaScript strings would therefore falsely
equate distinct stored values. The production fingerprint now reads TEXT via
CAST AS BLOB, uses typed length framing and includes database encoding; INTEGER
remains exact BigInt and NULL has a separate tag. The reproducer confirms distinct
digests even when decoded JavaScript strings match.

Scoped independent review plus root verification found no remaining reproducible
P1/P2 within the implemented boundary. Neither green tests nor this review proves
absence of all possible defects.

## Receipts and remaining work

Owned workspace receipts are outside the repository in
`tmp/reflexmesh-compaction-validation-t001/`: final full checks
`check-node22.log` / `check-node24.log`, focused and demo logs, and
`old-runtime-negative.log`. New-only retained synthetic lessons contain the
source, full archive and plan/attempt. After the operation's equality check,
their guard probes intentionally exercise later admission/pairing transitions;
the kept source is not asserted permanently equal to the old archive.

No real user ledger, paid model request, host application, profile/global runtime
change, existing PR merge or retarget occurred. Actual historical retention is
not delivered: it needs explicit archival coverage, batch receipts, required
ID/version tombstones and reader/backup/recovery upgrades. Broad host lifecycle,
provider quality, default-profile onboarding and independently authenticated
recovery gates remain open. Network/hostile filesystems, real ENOSPC, large-ledger
load, power-loss safety, physical allocated-byte savings and secure erasure are
not certified. Backup/compaction still never authorizes overwriting a current
ledger, losing newer guards or retrying UNKNOWN.
