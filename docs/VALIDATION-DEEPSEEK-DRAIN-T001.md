# DeepSeek shutdown drain diagnostics validation t001

Date: 2026-09-25. Scope: a local candidate that makes an unfinished observer
drain visible without relaxing the storage-closure invariant. This is local
evidence; exact-head PR CI and post-merge CI require separate verification.

## Defect and correction

Previously `reflexmeshObserverReady.shutdownMissingResults` was copied from
the observer's final disposal receipt. If one accepted call had already lost
its result while another `before` or `after` callback remained pending,
disposal correctly waited, but readiness still reported **zero** missing
results. This could mislead an operator investigating a stalled unload.

The observer now computes a frozen, scalar, read-only drain snapshot with
`closing`, `resultWindowClosed`, `pendingBefore`, `pendingResults`,
`pendingAfter` and `missingResults`. Loader readiness reads the live missing
count and exposes the same snapshot as `shutdownDrain`. The programmatic
plugin offers `drainStatus()` while mounted. Counts contain no call IDs,
Agent/session identifiers, arguments, result content or raw evidence.
Cordis may remove the readiness service as unload begins; an integration
must capture its reference before disposal to read the live getters while
that disposal is pending.

When the result-reception window closes with a `before` or queued/running
`after` callback still pending, the observer emits the fixed diagnostic
`reflexmesh_shadow_shutdown_drain_pending` once. It continues waiting for
those callbacks and closes the owned kernel only after they settle. A warning
means work was pending **at the window boundary**; it is not proof of a
permanent hang, and a zero-length window may report brief normal work.

## Local checks

- Focused observer, Loader and programmatic-plugin tests: **24/24 passed**.
  They cover live missing count during a gated admission, delayed result
  storage, immutable old snapshots, late completion and rejection, diagnostic
  callback reentry, one-shot warning, zero labels and real temporary SQLite
  readback after safe closure.
- `npm ci --ignore-scripts`: passed. `npm run check`: **846 tests, 844 passed,
  zero failed, two local symlink-privilege skips**; typecheck and build passed.
  `npm run demo`: passed.
- Installed DeepSeek Harness 0.1.2-rc.1, isolated synthetic transport:
  observer-teardown **9/9**, native tool pipeline **13/13**, CLI/Agent
  **12/12**, lifecycle matrix **17/17**, subagent isolation **12/12** passed.
  Those installed scenarios do not inject a permanently hung storage callback.
- No account, key, default profile, real model, production tool or user data
  was used.

## Boundaries

The diagnostic does not create a new total shutdown deadline or cancellation
contract. An arbitrary same-process callback that never settles still
prevents safe closure; forcing the kernel closed behind it could allow a late
write into closed storage. The result-reception budget only abandons calls
waiting for `tools/result`. Missing host observations remain **missing** and
cannot become fabricated failure/unknown/success, calibration labels, tool
retries or evidence that a host action did not run. An event-loop-blocking
callback can also prevent a JavaScript timer and diagnostic from firing.
