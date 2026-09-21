# Independent provider validation t002: clean-head smoke and CI follow-up

Date: 2026-09-22 (Asia/Shanghai). [PR #15](https://github.com/luomo66ccff/reflexmesh/pull/15).
This supplements, rather than replaces, [t001](VALIDATION-INDEPENDENT-PROVIDER-T001.md).
The initial report remains a dated snapshot; its original fixture-port strategy
was changed in this follow-up. Production provider/core/adapters/example files
are unchanged from the clean-head model smoke below.

## Clean-head real-provider receipt

The second, separately bounded real request ran on clean head
`feed2837cb8c5d07685ca73a115d72d824323803` at `2026-09-21T19:32:56Z`, Node
24.19.0. Official `deepseek-flash` returned HTTP 200 and 318 input/35 output
tokens; all 11 shipped example assertions passed. The model-authored binary
estimates remain uncalibrated. No tool or label was created, no profile was
loaded/modified, and replay/unsupported choice required no further request.

Total for this increment: two one-request synthetic runs, each 11/11, zero
tools/labels. Estimated peak token charge is US$0.0002748, using the rate basis
in t001; this is not an invoice. The later fixture-only follow-up does not
justify an extra paid-model call. The earlier report is not silently relabeled
as an exact-head run, and neither run proves model accuracy or host latency.

## Initial CI failure and precise uncertainty

The initial published head `feed283` passed Ubuntu/Node 22 and Windows/Node 24
in [CI 35645518578](https://github.com/luomo66ccff/reflexmesh/actions/runs/35645518578),
but Windows/Node 22 failed one existing synthetic `ignored_hooks` negative
control: it returned `probe_execution_failed` instead of the required
`probe_assertion_failed`. The old catch did not preserve exception phase or
errno; the exact cause cannot be established from that log. No assertion was
relaxed and the failed run remains part of the evidence.

The high-range random-port strategy was replaced with OS allocation plus
bounded filtering of the [Fetch blocked-port set](https://fetch.spec.whatwg.org/#bad-port),
avoiding assumptions about the host's dynamic or excluded port ranges. A
blocked assignment is closed before rebinding. Tests verify exhaustion
without a live listener, collision bounds, startup-handler cleanup and
immediate non-collision failure; `EACCES` is not swallowed or retried.

Fixed allowlisted failure-stage/error codes now identify future probe failures
without printing paths, tokens or raw exception text. Deterministic tests inject
a fixture-bind `EACCES` and a private unknown error; neither starts the host or
leaks the private value. The negative-control assertion includes only this
safe diagnostic on failure. This does not prove a particular errno caused the
original CI failure.

## Follow-up verification

- Helper tests: 4/4; independent scoped review found no blocker in the helper.
- Failure-probe tests: 42/42, including two new redaction/phase regressions.
- Node 22 affected negative control: 10/10 isolated local rounds passed.
- Full Windows Node 22.23.2 and 24.19.0 suites: 638 tests, 637 passed,
  zero failed, one expected symlink skip.
- Actual installed Claude 2.1.263 mixed-outcome probe with the new listener:
  19/19 on Node 22, isolated synthetic transport. Not a paid-model or profile test.
- Earlier clean-head actual generated setup (17/17 per scenario) and cold
  resume (20/20 per scenario) passed on Node 22 and 24; those are historical
  exact-head receipts, not silently claimed to run on a later commit.

Final follow-up exact-head CI and its log-derived totals are reported in the
PR verification comment. Production semantics, thresholds, bindings, outcome
rules and all quality/host/retention exclusions in t001 remain unchanged.
