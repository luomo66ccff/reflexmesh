# DeepSeek lifecycle validation: parallel, cancellation and task replacement

Date: 2026-09-21. Branch `feat/deepseek-lifecycle-matrix`, based on PR #6 head
`7811d35a6ebe5565c80c614fe896906d7a9f0294`. This is one additional host-lifecycle
increment, not completion of the [whole project](ITERATION-STATE.md).

## Defects reproduced and corrected

1. The installed ToolRuntime emits native `ABORTED` after body invocation,
   including when a cancelled body subsequently returns success. The previous
   observer mapped every `isError:true` to failed. A new regression failed
   against that behavior; the narrow native-code mapping now preserves unknown.
2. Result normalization formerly ran in a later microtask. A synthetic later
   listener could remove the Agent registry entry or mutate execution/result
   objects before journaling, losing or changing the observation. Both ordering
   regressions failed before the fix. Current identity, call and bounded result
   copy are captured synchronously; only journal work is deferred. Identity
   already invalid at notification is still rejected. The adversarial listener
   ordering is not claimed to occur during normal default host teardown.
3. Doctor did not warn for an unknown host outcome when the separate shadow
   decision row was completed. A fourth regression reproduced this missing
   diagnostic; the warning now covers either kind of uncertainty without
   changing storage, execution permission or the decision's completed state.

The result-byte limit matches the existing one-megabyte evidence boundary; it
is not a CPU or temporary-memory hard limit on traversing arbitrary objects.
No raw result is persisted. Historical observations are not rewritten.

## Actual installed-host execution

Root verification at **2026-09-21T15:03:47.459Z** ran:

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode lifecycle-matrix --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

Environment: Windows, Node.js **24.19.0**, npm **11.17.0**, installed DeepSeek
CLI/LLM/Agent/Agent-loop/Tools/Session/Headless packages **0.1.2-rc.1**, Cordis
**4.0.2**, Loader **1.0.3**, timer **1.1.4**. Adapter package version is
**0.2.0-alpha.1**. The final submitted Git head must separately pass its own CI.

Result: **17/17 assertions passed** across two independent temporary profiles.

| Scenario | Actual evidence |
| --- | --- |
| Parallel and replacement | Two native bodies entered the same barrier concurrently. The second threw and the first succeeded; body settlement was reversed while host result notification remained in model order. Exactly one steer produced exactly one new claimed task and one new tool call with a different selected-summary digest. |
| Cancel and followup | The original native body entered before real `agent.cancel`. A followup was queued and the body returned success. Native ToolRuntime produced `ABORTED`; the ledger recorded one unknown observation and no repeat of that call. A later turn completed the followup with its own summary digest. |
| Binding and lifecycle | Every expected call matched its exact key, tool/arguments digest, actual Agent/session scope digest, shadow/abstain binding and ready host-declared summary receipt. All had one harness-reported outcome, zero labels, natural `beforeExit`, observer-drained and kernel-closed proof. |

The report explicitly keeps `evidenceLevel: cli_agent_lifecycle_matrix`,
`agentE2E: false`, `modelInference: false`, `modelTransport: synthetic_adapter`,
and `classification: abstain`. These are real installed host components, but
the model transport and test tools are synthetic. The separate
[authorized real-model test](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md) remains
dated evidence for its own earlier exact baseline, not this matrix.

Temporary ledgers were closed before their validated temporary directories were
removed. No user profile, credential, transcript, production tool or remote
model was loaded. Elapsed time is a diagnostic, not a performance benchmark.

## Review and regression checks

- Independent fixture review caught repeated `steer()` on the later new result:
  the old-result count stayed two. It is now single-shot, with exact steer and
  new-claim counters. The passing result above is after this correction.
- Root review required explicit per-call provider/mode/scope/action checks,
  safe turn integers, fixed Node 22 SQLite-warning handling and validated
  recursive temporary-test cleanup. It did not relax outcome assertions.
- An independent read-only review of the production observer/doctor changes
  found no remaining blocking issue; root reproduced the failures and reran
  affected checks before the final suite.
- `npm ci --ignore-scripts --no-audit --no-fund`: passed in the new worktree.
- `npm run check`: **231 tests, 230 passed, 0 failed, 1 expected Windows symlink
  skip**. New tests include six result-lifecycle cases, one doctor uncertainty
  case and four lifecycle receipt/transport/installation-contract cases.
- Four offline examples passed; they still use no credentials or remote model.
- Existing installed native tool-pipeline probe: **13/13**; existing installed
  synthetic CLI/Agent probe: **12/12**, both rerun after the observer fix.
- Root separately reran the new installed lifecycle wrapper: **17/17**.
- `git diff --check`: passed. Remote CI is separate exact-head evidence; its
  tests do not install DeepSeek or substitute for the local host execution.

## Remaining boundaries

No claim for default-profile compatibility, real subagents, process restart,
forced kill, missing-result recovery, live Linux installation or the separate
tool-timeout policy. Cross-host lifecycle work remains open. A host-reported
failure is not a rollback guarantee, and an unknown observation is not retry
permission. The observer does not become an execution lock or modify host
authorization. Process limits cannot prove all descendants stopped or all
external effects were absent. No new provider, calibration claim, automatic
label or universal absence-of-bugs certification is introduced.
