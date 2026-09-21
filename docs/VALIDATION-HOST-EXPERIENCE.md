# Host evidence experience: validation record

This increment integrates the previously local real-host probe with reviewed
main, adds an explainable read-only evidence CLI, and exercises an installed
DeepSeek native tool pipeline. It does not certify production safety or finish
the broader [acceptance gates](ITERATION-STATE.md).

## Environment and reproducibility

- Date: 2026-09-21.
- Local platform: Windows, Node.js 24.19.0, npm 11.17.0.
- Installed DeepSeek packages: `dsh`, `dsh-tools`, `dsh-system-prompt`
  0.1.2-rc.1; `@deepseek-ai/cordis` 4.0.2.
- Full CLI/Agent/model E2E: **not run**.
- Real Jev inference and real classification accuracy: **not run**.

Commands and the pinned package layout are documented in
[DEEPSEEK-HOST.md](DEEPSEEK-HOST.md). The probe uses real installed Cordis and
ToolRuntime modules, but its task, classifier and no-op tool are synthetic.
The default DeepSeek mode remains version discovery only. No host configuration
or user profile is modified. Existing Codex/Claude results remain the dated
[2026-09-19 baseline](VALIDATION-REAL-HOSTS.md); they were not rerun here.

## Evidence CLI verification scope

Focused regressions cover read-only schema-1/schema-2 inspection, no schema
migration, no creation of missing databases, stable bounded keyset pagination,
transactional reads, missing task/outcome states, conflicting outcomes,
operator conclusions that never enable execution, malicious/oversized metadata
and absence of raw summary/argument/output leakage. `confirm` remains a
confirmation request. Default human output distinguishes model reports from
harness observations.

`demo:evidence` walks through missing task evidence, a decision without a host
result, a separate fixture outcome, and clearing the task. The verified output
has one fixture provider call, duplicate decision replay, and zero labels. It
is explicitly synthetic and removes its temporary local storage after closing.

## Defects discovered during review

- `confirm` policy effects were initially omitted from the inspector's display
  whitelist. They are now preserved in JSON and human output with regressions.
- Human output initially hid outcome provenance. It now displays source/status
  counts so a model's success claim is not presented as a host observation.
- DeepSeek plugin disposal originally waited only for queued `after` writes.
  A real installed-pipeline reproduction showed `before` could still be waiting
  after disposal returned; the host then ran the tool without recording its
  outcome. The fix now covers that entire accepted call, not merely the provider.
  Cordis cleans independent effects concurrently; one composite effect preserves
  the original plugin scope and orders drain before result-hook removal. A real
  gated-before/gated-after regression confirms disposal stays pending until the
  result is recorded. No host tool is cancelled or retried by this fix.

## Installed native-pipeline result

The root verification at `2026-09-21T13:13:58.900Z` passed **13/13** assertions:

- Cordis plugin mounted and unmounted.
- Ready selected-task receipt, native tool execution and bound outcome.
- Duplicate decision uses one provider call, while the host still executes twice
  (explicitly not an execution deduplication guarantee).
- A tool-body exception after accepted pre-execution produces a failed outcome.
- Pre-dispatch cancellation skips the tool body.
- Disposal waits through held pre-execution, actual tool result and held `after`.
- Post-disposal host execution adds no observation; caller-owned kernel stays open.
- Zero truth labels and zero observer errors.

The report states `evidenceLevel: native_tool_pipeline`, `agentE2E: false`, and
`classification: synthetic_classification`. Missing/unsupported-package tests
also verify nonzero CLI exit and fixed, sanitized failure diagnostics.

## Final checks

- `npm run check`: **196 tests, 195 passed, 0 failed, 1 skipped** on local
  Windows/Node 24. The skip remains the unprivileged symlink-input test.
- `npm run demo`, `demo:durable`, `demo:recovery`, and `demo:evidence`: passed.
- `git diff --check`: passed.
- Installed native DeepSeek probe: **13/13** assertions passed, as detailed above.
- Independent read-only review checked evidence display/provenance and the
  lifecycle fix; the issues found were fixed and their regressions passed.
- Offline CI now includes the explained walkthrough plus synthetic composite
  cleanup, capacity and registration-failure tests. These fixtures do not count
  as installed-runtime evidence.

One initial full-check attempt was stopped while two historical DeepSeek fixtures
waited for disposal without ever emitting terminal results. The fixtures now
complete the host lifecycle, retain their original task/next/cancellation
assertions and bound test duration. No assertion was removed or timeout increased
to disguise the wait. The final full run above passed.

Exact-head remote CI is published on [PR #4 checks](https://github.com/luomo66ccff/reflexmesh/pull/4/checks).
Match the check run's commit to the reviewed head before relying on its result;
earlier baseline CI is not evidence for these changes.

## Explicit exclusions

- DeepSeek CLI profile loading, actual Agent identity/task propagation, a real
  model loop, and a production authorization boundary.
- Complete parallel/cancellation/crash/restart coverage across all hosts.
- Concurrent parent/root Cordis teardown without host quiescence.
- Preventing host execution duplicates: decision reuse is not tool retry safety.
- Calibrated model scores, an independent second provider, or automatic labels.
- Arbitrary-size database constant-time queries, tamper-proof evidence,
  authenticated recovery actors, or an absolute absence-of-bugs guarantee.
