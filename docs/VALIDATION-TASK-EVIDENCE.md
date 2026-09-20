# Validation: selected task evidence

Date: 2026-09-18. Base commit: `5253d034c30b2cda55b2738f729fe5ae8f551b11` (PR #2, recovery reviews). This change is a separate stacked PR, not an implicit merge of that base into main.

## Local checks actually run

- Node.js 22.16.0; installed TypeScript 5.8.3, matching the project's build dependency.
- Focused workspace `npm run check`: **89 tests passed**, zero failures/cancellations/skips. It contains the original 45 core tests plus 44 new task-evidence tests.
- The 44 new tests cover real hook/MCP subprocesses, explicit-only capture, invalidation, TTL, scope/provenance, transactionally bounded cache capacity, concurrent OS process startup, last-mile evidence checks, and unchanged host execution/permission delegation.
- New offline demonstration ran successfully. All probabilities, source texts and outcomes in it are clearly marked synthetic fixtures, not actual model predictions or host tool runs.
- GitHub and npm DNS were unavailable in the container. Files needed from the durable/recovery layer were recovered through the authorized connector and checked against Git blob hashes. No fresh local clone/install or complete local rerun of the previous 117 tests is claimed.

Full regression for the stacked branch must be checked using the PR's GitHub Actions result. Existing tests are not removed or skipped by this change. CI results should be attributed to their exact commit/check run rather than predeclared in this static report.

## Boundaries not established by these tests

Actual Codex, Claude Code and DeepSeek Harness clients were not installed or launched here; interface-shaped fixtures and this project's protocol entrypoints were tested. No real Jev request, calibrated accuracy benchmark, security audit, exhaustive secret detection, secure physical erasure or distributed ordering guarantee was performed.

The intent cache contains selected plaintext summaries only after explicit opt-in. The main ledger contains digests and bounded provenance metadata. TTL blocks expired use but does not mean immediate physical deletion while no cache process is running. Root/subagent isolation is intentional; complete task understanding and human authority are not inferred from a selected summary.
