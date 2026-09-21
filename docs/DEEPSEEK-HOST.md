# DeepSeek native tool-pipeline integration

The observer can be mounted as a Cordis plugin. It leaves permission decisions
and tool execution with DeepSeek. It neither changes an agent loop nor installs
itself into a user's profile.

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
});
const fiber = await ctx.plugin(observer);

// After awaiting a host tool execution, drain its queued observations:
await observer.flush();

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

Disposal stops accepting new pre-observations and drains accepted calls through
their final result and queued storage write before removing the result hook.
Cordis hooks and the drain share one ordered effect in the original plugin
context. If an accepted host call never produces its terminal result, disposal
can remain pending; a concurrency bound is not a deadline or a cancellation
mechanism. Whole-host shutdown still requires the host to quiesce its tools
before tearing down services. Never close the caller-owned kernel early to
force an apparently successful unload.

At most 256 accepted observations are tracked at once. Overflow emits a fixed
diagnostic and skips that observation while still delegating to host policy.
Unpaired result events are ignored; they cannot invent an admission record.

Duplicate calls can reuse a semantic decision and deduplicate observations.
They **do not** prevent DeepSeek from executing a tool twice: this is a shadow
observer, not a host execution lock.

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
