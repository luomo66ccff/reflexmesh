# Stack integration validation t001

Date: 2026-09-22 (Asia/Shanghai). This is a scoped internal release-candidate
check, not an external security audit or a claim that all bugs are absent.

## Reviewed and merged identity

- Repository: `luomo66ccff/reflexmesh`; verified writer: `Amahane-Hikari`.
- Immutable review: main `bd0d1ed18c169ae202493c11ade10a874e6539b9` through
  stack tip `f0a0a62085e5c01a2e6980719b24b7f3ca1da420` (PRs #4–#21).
- [Integration review](https://github.com/luomo66ccff/reflexmesh/pull/21#issuecomment-5769071917)
  covered all 85 generated changed-source items: root 30, separate host reviewer
  34, provider/runtime reviewer 21. Root verified material control claims. No
  reportable security candidate or concrete P1/P2 functional blocker remained
  within that scope. Tests, fixtures, documentation and unchanged code were
  supporting material, not a claim of exhaustive review of unrelated source.
- PR #21 was retargeted to main only after rechecking the exact base/head and
  successful checks. The prospective merge tree matched the tested tip.
- [PR #21](https://github.com/luomo66ccff/reflexmesh/pull/21) merged as
  `d5457ca594a3a134764a68262b1974ad5046711f`. Readback verified both parents and
  exact tree equality with the reviewed tip. All reviewed stack heads are
  ancestors of main; no squash, rebase, force-push or branch deletion occurred.
- GitHub marks #4 and #21 `MERGED`. It rejects retargeting the already-contained
  older heads because main has no new comparison. PRs #5–#20 were individually
  verified as contained, commented with the integration reference and closed as
  already integrated. Their `CLOSED` state is not represented as a separate
  merge. No open PR remained after this stack cleanup.

## Fresh checkout

A new clone at the exact tip, independent of prior worktrees, passed:

- `npm ci --ignore-scripts --no-audit --no-fund`;
- runtime preflight: Node 24.19.0 / SQLite 3.53.3 on Windows;
- `npm run check`: typecheck passed; 811 tests, 809 passed, zero failed and two
  existing local symlink-privilege skips;
- all nine offline examples: workflow, durable shadow, recovery review, task
  intent/explanation, paired provider comparison, storage diagnostics, backup,
  compaction and audit archival.

The local skips were actual-link tests for backup source/reserved target paths
and recovery review input. They were not relabeled as passes. The clone was
then switched to merged main; identical tracked source trees make these the same
code-level checks, not a second independently executed full suite.

## Exact merged-main CI

[CI 35668506115](https://github.com/luomo66ccff/reflexmesh/actions/runs/35668506115)
completed successfully on merge commit `d5457ca594a3a134764a68262b1974ad5046711f`.

| Job | Observed result |
| --- | --- |
| Ubuntu, Node 22.23.2 / SQLite 3.51.3 | 811/811 tests, zero skips; nine offline demos passed |
| Windows, Node 22.23.2 / SQLite 3.51.3 | 810 passed, one existing review-input symlink skip; nine demos passed |
| Windows, Node 24.20.0 / SQLite 3.53.4 | 810 passed, one existing review-input symlink skip; nine demos passed |
| Ubuntu and Windows, affected Node 22.16.0 / SQLite 3.49.1 | 14 negative scenario groups passed on each OS; persistent writes blocked before user-ledger mutation |

The old-runtime check does not reproduce database corruption or certify general
SQLite safety. Local test/demo/install and main CI logs are retained in the
workspace receipt directory `tmp/reflexmesh-stack-integration-validation-t001`.
The separate immutable security scan bundle is retained locally with its
canonical coverage and generated report/SARIF; its source inventory is complete
for the declared diff, not for all possible deployment behavior.

## Preserved boundaries and remaining work

The merge changes no permission model: host adapters stay advisory/shadow,
semantic allow is not authorization, external provider transfer is explicit,
provider capabilities/model/deployment stay bound to evidence, and observations
are not independent truth labels. UNKNOWN stays non-retryable.

Backup/compaction/archival are separately invoked local maintenance operations,
not host/model tool grants. They preserve execution guards and treat lost apply
receipts as unknown; archive hashes are not origin authentication, freshness,
external-chain availability or production restore permission.

This review made no real model requests, real host-process launches, user-profile
changes, production-ledger maintenance or global runtime/configuration edits.
Broader host shutdown/cancellation, actual default-profile onboarding, distinct
real-provider quality/calibration, authenticated recovery and broader load/privacy
acceptance remain open in [iteration state](ITERATION-STATE.md). A green main
delivers this tested increment; it does not finish the long-term objective.
