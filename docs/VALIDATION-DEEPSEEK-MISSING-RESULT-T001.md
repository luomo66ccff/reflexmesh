# Installed DeepSeek missing native-result validation t001

Date: 2026-09-25. Scope: installed DeepSeek Harness `0.1.2-rc.1` on Windows,
using its CLI, Loader, Agent loop and native ToolRuntime with a disposable
profile, synthetic model adapter, one in-memory tool and ReflexMesh's abstaining
shadow observer. No account, real model, user profile or production ledger was
used.

## Reproduce

After `npm run build`, use a trusted installed package root; this command
executes that host package's code:

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-missing-result --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

Add `--out-dir ABSOLUTE_NEW_DIRECTORY` to retain the synthetic profile and
ledger, fixture telemetry, receipt and `START-HERE.md`. The isolated host may
also create its own local cache files there. The output directory must not
exist. Without it, the disposable fixture is removed after verification.

The synthetic native tool body enters once and never settles. An independent
fixture continuation unloads the observer through the official Loader with
`shutdownResultWaitMs: 0`. Its own keepalive prevents a pending Promise from
looking like a natural Node exit. The parent verifies ordered, run-bound IPC,
then reads the ledger **before** terminating only the child it started. It
confirms that process has closed and reads the ledger again. An early exit,
timeout, IPC mismatch, failed readback or unconfirmed termination fails the
probe; a watchdog stop is never counted as host completion.

## Observed local result

- Root independently ran the installed-host wrapper with a retained, new-only
  synthetic directory. It passed **9/9 fixed assertions** and reported
  `exitKind=supervisor_terminated`, `nativeToolBodyEntered=true`,
  `nativeResultReceived=false`, `agentCompleted=false`, `agentE2E=false` and
  `modelInference=false`. The child PID was no longer running after the probe.
- Before unload, the observer had `pendingResults=1`. After unload, its
  `pendingBefore`, `pendingResults` and `pendingAfter` were zero,
  `missingResults=1`, `observerDrained=true` and `kernelClosed=true`.
  No native `tools/result` was emitted.
- Read-only pre-stop and post-stop ledger projections matched: one completed
  shadow decision, a **missing** host outcome with zero observations, zero
  labels, abstaining provider and the expected task/Agent/session/action
  binding. The public `evidence attention` CLI showed exactly one
  `shadow_outcome_missing` reason. The public doctor returned
  `prerequisites_ready` with informational `historical_outcome_missing` and
  `live_host_unverified`, not `historical_unknown_execution`.
- The new fixed receipt/IPC/retention/doctor tests passed **23/23**. After
  `npm ci --ignore-scripts`, root ran `npm run check`: **919 tests, 917 passed,
  zero failed, two local Windows symlink-privilege skips**. `npm run demo`
  passed. Existing installed teardown, fence, pending-before and pending-after
  probes still passed 9/9, 10/10, 8/8 and 8/8 respectively.
- A scoped independent review found that a first draft could use stale
  pre-stop telemetry to miss a late native result and had no live Agent
  completion signal. The final probe compares both telemetry snapshots and
  listens for the installed host's `turn/end` session event. It also preserves
  the original timeout reason when the fixture never reaches readback. The
  outer wrapper reports `unverified`, with unknown result/completion fields,
  when it cannot start or verify the probe; focused regressions and the
  installed scenario passed again after these changes.

## Evidence boundary

This proves a narrow observer and evidence behavior while a deliberately
unresolved synthetic native body is held under supervision. The supervised
process termination is **not** an Agent result, graceful host shutdown, tool
cancellation or evidence that arbitrary real-world effects are absent. The
installed ToolRuntime awaits a started tool body even after a cancellation
signal; neither ReflexMesh nor this probe imposes a general host-tool timeout.
The observation window cannot prove that an arbitrary external tool will
never return, only that this fixture did not return before its supervised stop.
Default-profile compatibility, real-model quality, event-loop blocking,
arbitrary callback providers and broader cross-host lifecycle remain open.
No `missing` outcome authorizes an automatic retry.
