# Audit archival validation t001 — 2026-09-22

Scope: `feat/audit-archival`, based on PR #20 head
`c4471de112666bcee6c9ac883b70014b0b08e695`, not merged main. All destructive
checks used newly owned synthetic fixtures. Publication and exact-head CI must
be verified separately; earlier PR CI is not evidence for this increment.

## Local checks

| Runtime on Windows | Complete check before final test-only cleanup fix | Final focused check | Offline demos |
| --- | --- | --- | --- |
| Node 22.23.2 / SQLite 3.51.3 | 810 tests, 808 passed, 0 failed, 2 skips | 34/34 | 9/9 |
| Node 24.19.0 / SQLite 3.53.3 | 810 tests, 808 passed, 0 failed, 2 skips | 34/34 | 9/9 |

`npm ci --ignore-scripts`, build, typecheck and full checks passed. The final
change after the full suites was test-only: bound the child barrier wait and
add one never-sends-barrier regression. Production code did not change. Both
runtimes then reran all 20 core and 14 workflow tests on that final test tree;
the final repository has 811 test cases for its next full CI run. The two local
skips are existing backup-input and review-input Windows symlink capability
checks, not new archival skips. No full final-tree local count is invented.

The affected official Node 22.16.0 / SQLite 3.49.1 passed **14 negative scenario
groups**, including archival apply refusal before directory reservation or
writable open. This is not reproduction of SQLite's corruption race. That old
runtime also successfully verified the retained schema-4/v2 archive read-only.
No global Node/PATH setting was changed.

## Demonstrated behavior

- Real CLI preview/apply/inspect/history/query through quoted Chinese/space paths.
  Preview leaves application rows unchanged; apply deletes only selected audit.
  A new-only plan/attempt is mandatory and concurrent processes dispatch at most
  once per plan. Changed source, wrong backup, missing quiescence, pre-abort,
  malformed plans and overlapping outputs never become a successful deletion.
- The retained two-batch lesson archives **42 rows, then 1 row**. An intervening
  append becomes the new anchor. The original run's audit details are retrieved
  byte-for-byte across both batches; the new anchor remains online. A separate
  retained-content fingerprint checks the six non-audit tables and previous
  archival metadata before commit, alongside the guard probes below.
- Completed replay, UNKNOWN, expired execution, labels, observation provenance,
  operator review and pending/blocked/ready/pair-only guards remain intact.
  No retrieved evidence authorizes a retry, restore or tool action.
- Schema 3 changes to 4 only in the explicit archival transaction. Ordinary opens
  remain 3 or preserve 4. INT64 exhaustion rejects append; sequence IDs above
  2^53 and malformed UTF-8 detail bytes retain exact digest/readback semantics.
- SQLite exclusive maintenance rejects an already-open read-only connection
  without migration/deletion. After all connections close, apply can proceed.
  A **separate synthetic ordinary WAL migration**, not product archival, proves
  this version's long-lived reader refreshes schema and sees coverage.
- Independent child kills at **before-COMMIT** and **after-COMMIT** reopen as a
  complete pre- or post-archival state. This does not test a kill inside the
  SQLite COMMIT instruction or physical power loss. Post-commit callback and
  parent receipt/publication failures remain unknown with a spent attempt.
- Per-run digest verification precedes query paging. Missing/wrong run, batch
  or archive does not return successful empty history. Explicit raw output is
  capped by individual/page bytes and actual serialized size. Escaped 128-byte
  kinds plus details, and a history page from **50 real core archival batches**,
  pass through the 64 KiB worker protocol. Raw core backup fixtures in that
  history stress test are not claimed to be published complete archives.
- Corrupt coverage hashes, orphan references, wrong source-version ordering and
  a lowered highwater are rejected by explicit evidence/coverage readers and
  maintenance. Ordinary writes do not authenticate or repair archive metadata.
  Storage diagnostics retain bounded LIMIT scans and make no full-chain claim.
- Schema-4 backup/compaction preserve all nine tables with explicit v2 artifacts.
  Existing retained PR #19/#20 v1 archives still verify, and the old compaction
  receipt still reads as recorded completion. No old artifact was rewritten.
  Verifying a new backup does not establish older external archive availability.

## Review corrections

Independent architecture/core/wrapper review plus root verification found and
closed three P2 issues: full-chain traversal hidden inside bounded storage
diagnostics; UTF-16 keys accepted by preview but not usable for coverage insert;
and a test child barrier that could outlive the test timeout. Ordinary writes
also no longer rescan the full chain. Archival now rejects unsupported encoding
and non-queryable run keys before selection; raw-byte backup/compaction support
is not weakened. The test fixture now has real barrier/close deadlines and a
never-send negative case. No remaining reproducible P1/P2 was found in the
reviewed scope; this is not proof of the absence of all possible defects.

## Receipts and limits

Receipts are outside the repository at
`tmp/reflexmesh-audit-archival-validation-t001/`: `check-node22.log`,
`check-node24.log`, `focused-final-node22.log`, `focused-final-node24.log`,
nine demo logs per runtime, old-runtime/legacy verification receipts, and
`retained 中文 lesson/` with the source, three archives and operation plans.
The retained lesson's later guard probes intentionally mutate its live source;
it is not promised permanently identical to a prior backup/compaction snapshot.

No paid model request, real user ledger, production restore, settings/credential
change, existing PR merge or retarget occurred. Actual archival supports UTF-8
schema 3/4 and bounded selected run keys/positive sequences; it is not arbitrary
SQLite migration. Total backup storage reduction, secure erasure, archive
authenticity, external chain availability, power loss, real ENOSPC, hostile or
network filesystem races and large-ledger privacy/load acceptance remain open.
Other evidence bodies are not pruned; their conflict/idempotency contracts need
separate design. Broad lifecycle/provider quality/default-profile onboarding
and production recovery gates remain open. Next priority is stacked integration
and a release-candidate first-run check, not a declaration that main has these
unmerged features or that the whole project is bug-free.
