# SQLite startup race watchdog — local validation t001

Date: 2026-09-25. Scope: the account-free four-process startup-race test harness. Production SQLite admission, contention budgets, no-retry semantics and adapter code are unchanged.

## Trigger and diagnosis

The [PR #76 checks](https://github.com/luomo66ccff/reflexmesh/pull/76) passed on Ubuntu Node 22 and Windows Node 22/24. After merging the identical tree, [main CI run 36144882669](https://github.com/luomo66ccff/reflexmesh/actions/runs/36144882669) failed only `test (windows-latest, 24)`: `repeated fresh-database startup races still yield one admission across four OS processes` hit its fixture IPC deadline of 4 seconds. The assertion did not report a competing claim or an incorrect SQLite verdict; no child stderr was recorded. The same main run's four other jobs passed. This is evidence of an overly tight test watchdog under that run, not proof that every startup race is safe or that a product deadlock is impossible.

The fixture's kernel uses a 2-second SQLite contention budget per process while four independent child processes race to open and claim a fresh ledger. The test's 4-second external IPC watchdog mixed a correctness assertion with shared-runner scheduling latency. Local Node 24.19.0 / SQLite 3.53.3 repeated the original focused file 5/5 times (about 2.1–2.3 seconds per run); the failure was not reproduced locally. A shared-runner scheduling delay is an inference from the different PR/main results, not a measured cause.

## Test repair

- The per-message IPC watchdog is now 12 seconds and remains finite. The eight-round test's outer deadline is 120 seconds, so a child that does not answer still fails rather than hanging indefinitely.
- A future IPC deadline includes the synthetic round, worker, ready/claim phase and recorded open duration. It does not print paths, SQL or fixture exception bodies beyond the existing bounded stderr suffix.
- The invariant is unchanged: in each of eight rounds, four OS processes must yield exactly one `claimed` and three `busy` replies. No application retries, policy changes or host permissions were added.

After the repair, the focused test file passed 10/10 consecutive local runs (about 2.2–2.6 seconds each). `npm ci --ignore-scripts`, `npm run check` (**975 tests: 973 passed, 0 failed, 2 local Windows symlink-privilege skips**) and `npm run demo` passed. Remote CI is a separate gate; record its final result before claiming this branch green.
