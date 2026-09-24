# DeepSeek native tool-pipeline integration

The observer can be mounted as a Cordis plugin. It leaves permission decisions
and tool execution with DeepSeek. It neither changes an agent loop nor installs
itself into a user's profile.

For an opt-in profile entrypoint that owns its ledger and resolves actual Agent
identity without custom callbacks, see [CLI/Agent integration](DEEPSEEK-AGENT.md).
The programmatic integration and native tool-only probe below remain distinct.

## Explicit, host-owned wiring

Build ReflexMesh first. Inside trusted host integration code, provide an
existing boundary and resolvers:

```js
import { createDeepSeekHostPlugin } from './adapters/deepseek-host-plugin.mjs';

const observer = createDeepSeekHostPlugin({
  boundary, // TaskAwareBoundary or ShadowBoundary; caller owns its storage
  identity: resolveTrustedSessionAndAgent,
  resolveIntent: selectMinimizedTaskEnvelope,
  onError: code => reportFixedDiagnostic(code),
  shutdownResultWaitMs: 5000, // optional; result-reception window, not tool timeout
});
const fiber = await ctx.plugin(observer);

// After awaiting a host tool execution, drain its queued observations:
await observer.flush();

// Optional, read-only live diagnostic while mounted (null after unmount):
const drain = observer.drainStatus();

// Stop dispatching new host tools and settle/cancel active tools in HOST code.
await fiber.dispose();
// Only now may the storage owner close its kernel.
```

The identity resolver must return stable `sessionId` and `agentId` values from
trusted host state. `resolveIntent` is optional; with `TaskAwareBoundary`, missing
or invalid task evidence suppresses assessment rather than inventing intent.
When supplied, return an explicit selected task envelope with matching harness,
session and agent scope, source, issuance and expiry; see [TASK-EVIDENCE.md](TASK-EVIDENCE.md).
Do not serialize the live context or copy a transcript into this callback.

Each plugin instance owns one mount. It does not own the database and never
closes it. `flush()` waits for the currently accepted calls' final observations;
it does not prevent new dispatch and is not a whole-host completion barrier.
Before shutdown, the host must stop new tool dispatch and
settle or cancel its own active work. An observer cannot prove that a missing
result means a tool did not run, or safely retry that tool.

Disposal stops accepting new pre-observations, then accepts authoritative
results for up to five seconds by default. `shutdownResultWaitMs` is a safe
integer from 0 to 60000 milliseconds; the first shutdown starts one window,
and repeated disposal cannot extend it. At expiry, calls still waiting for a
result are released as **missing**, not reported unknown, failed or succeeded.
No outcome row, label or retry is created; a saved late result callback cannot
append an observation. Admission and result-storage callbacks already in
flight must still settle before disposal completes. Cordis hooks and the drain
share one ordered effect in the original plugin context. This is an observer
shutdown budget, not a host tool deadline or cancellation mechanism. The host
must still quiesce its tools; a permanently hung admission or storage callback
can still prevent safe closure. Never close the caller-owned kernel early.
`drainStatus()` returns a frozen scalar snapshot with `closing`,
`resultWindowClosed`, `pendingBefore`, `pendingResults`, `pendingAfter` and
`missingResults`; it contains no call, Agent or result data. The `pendingAfter`
count includes journal work queued but not yet running. A saved snapshot does
not change as later work settles. If the result-reception window closes with
admission or captured-result storage still pending, the observer emits one
`reflexmesh_shadow_shutdown_drain_pending` diagnostic and continues waiting.
This means pending **at the window boundary**, not necessarily hung forever;
with a zero-length window even normal short drain work may qualify. The
diagnostic is not permission to close storage, cancel a tool or retry it.
The [drain validation](VALIDATION-DEEPSEEK-DRAIN-T001.md) separates this
read-only diagnostic from an actual total shutdown guarantee.

At most 256 accepted observations are tracked at once. Overflow emits a fixed
diagnostic and skips that observation while still delegating to host policy.
Unpaired result events are ignored; they cannot invent an admission record.

Only a successfully resolved `boundary.before` can own an outcome. A rejected
admission (for example, a reused call ID with a different task) releases its
observer slot immediately and cannot append a result to an older ledger row.
At result delivery, the normalized call must still match the admitted call,
and any Agent/session object references must be unchanged. Identity is checked
again against current host state; the old identity is not used as a fallback.
Changing the current selected task does not invalidate a correctly paired
result for a tool that already started under the earlier task.

Here “resolved” means that the full semantic input matches the admitted record,
not that this observer newly acquired its lease or that execution succeeded.
Matching replay, in-flight and UNKNOWN records can still receive host-reported
observations. That never completes an UNKNOWN run, releases its tombstone,
creates a truth label or authorizes another tool execution.

At result notification, current identity and a bounded private result copy are
captured synchronously; later listener changes cannot rewrite the queued
observation. Native post-dispatch `ABORTED` is recorded as reported unknown,
not proof of an effect-free failure. See the [lifecycle guide](DEEPSEEK-LIFECYCLE.md)
for the mapping, migration boundary and optional installed-host scenarios.

Duplicate calls can reuse a semantic decision and deduplicate observations.
They **do not** prevent DeepSeek from executing a tool twice: this is a shadow
observer, not a host execution lock.

A reused call ID with changed evidence is a conflict, not an invitation to retry
the tool or rename its existing ledger row. Host integrations should supply a
unique call ID for each distinct invocation. A fixed observation-failure warning
and a missing outcome do not mean that the host tool failed or did not execute.
Historical misattributed observations are not automatically repaired: the
ledger cannot reconstruct the missing invocation identity. See the
[admission-pairing validation](VALIDATION-OUTCOME-ADMISSION.md).

## Opt-in probe using an installed package

The default `--host deepseek` mode only discovers a version. To exercise the
installed native components without starting a model or reading a user profile:

```bash
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-package-root /absolute/path/to/node_modules/@deepseek-ai/dsh
```

Only point this option at a trusted installation: it imports and executes those
installed packages. The probe supports the inspected versions of `dsh`,
`dsh-tools`, and `dsh-system-prompt` **0.1.2-rc.1**, with `@deepseek-ai/cordis`
**4.0.2**. Missing packages, unknown versions, timeout, malformed output or failed
assertions fail closed; a new version requires another source review.

The child receives a minimal environment, uses an in-memory database, an
explicit synthetic task, a MockProvider and an in-memory no-op tool. It invokes
the installed `ctx.tools.execute` pipeline and real Cordis plugin lifecycle.
No user settings are edited, no model credential is loaded by the probe, and no
real model inference or external tool action is requested. The parent bounds
runtime and captured output and reports only fixed diagnostics.

A passing report is deliberately labeled:

```json
{
  "evidenceLevel": "native_tool_pipeline",
  "agentE2E": false,
  "classification": "synthetic_classification"
}
```

It is not evidence for the CLI profile loader, an actual Agent/model loop,
authenticated real-agent identity propagation, classification accuracy,
calibration, or every host cancellation/restart path. See the [validation
record](VALIDATION-HOST-EXPERIENCE.md) and [open gates](ITERATION-STATE.md).
