# DeepSeek observer shutdown validation t001

Date: 2026-09-24. Scope: a local candidate for bounded observer result
reception and safe Loader-owned kernel closure. This report is local evidence;
reviewed PR, exact-head CI and post-merge CI require separate readback.

## Defects and correction

An accepted DeepSeek tool with no `tools/result` previously left observer
`dispose()` waiting indefinitely, so the Loader could not close its kernel.
The observer now starts one result-reception window on first shutdown (default
5000 ms; optional validated `shutdownResultWaitMs` from 0 to 60000 ms). Once
it expires, only accepted calls still waiting for a result are released. Their
ledger outcome remains **missing** and receives read-only attention; there is
no invented failed/unknown/succeeded host report, label, retry or tool
cancellation. The fixed warning and Loader readiness count expose the loss.

An adversarial early `tools/result` could also release the drain token while
`boundary.before` was still in flight. The observer now rejects that pairing
without releasing the token until admission settles, and refuses a later
replacement result. Captured results, including queued journal microtasks,
remain owned until `boundary.after` settles. Saved result callbacks cannot
write after the result window closes. A zero-window warning callback could
reenter disposal before its promise was published and double-count one missing
call; the unique shutdown promise now precedes callbacks, and a regression
checks same-receipt single counting. The Loader still closes its kernel only
after observer disposal completes.

## Local checks

- New synthetic tests cover no-result deadline, in-window result, pending
  admission, queued/running result write, early result, mixed calls, warning
  reentry, simultaneous Cordis/manual unload, stale callback and invalid
  budget values. The Loader integration test uses a real
  temporary SQLite ledger and verifies a closed kernel, `missing` outcome,
  one `shadow_outcome_missing` attention reason and zero labels.
- `npm run check` on Windows Node 24.19.0: **838 tests, 836 passed, zero failed,
  two local symlink-privilege skips**; typecheck and build passed.
- `npm run demo`: passed.
- Installed DeepSeek Harness 0.1.2-rc.1, isolated synthetic transport:
  native tool pipeline **13/13**, CLI/Agent loop **12/12**, lifecycle matrix
  **17/17** assertions passed. These existing host scenarios return their
  tool results; they do **not** exercise the missing-result shutdown deadline.
- The candidate uses no real model account, credential, default user profile,
  transcript, production tool or remote inference.

## Boundaries

The five-second default is an observer cleanup policy, not an empirical host
latency SLO. A missing result means the outcome is unverified, not that the
tool did nothing. Already running admission or result-storage callbacks still
must finish before safe kernel closure; if either never settles, disposal may
remain pending. This is not a total host shutdown deadline, external effect
reconciliation, default-profile certification or broad lifecycle acceptance.
The installed-host missing-result path itself remains unexercised; the bounded
case here is synthetic observer and Loader integration with a real local ledger.
