# DeepSeek CLI and Agent-loop integration

This opt-in entrypoint lets an existing DeepSeek profile load ReflexMesh without
writing custom identity or lifecycle callbacks. It is a shadow observer, not a
replacement Agent loop or permission system. It targets the inspected DeepSeek
Harness **0.1.2-rc.1** contracts; other versions need another compatibility check.

## Start with a private ledger and no task capture

Start with the [read-only doctor](DOCTOR.md) to check the selected installation
and obtain an escaped configuration snippet. It works even before the build;
it will explain that missing prerequisite instead of loading the host.
Before editing an existing profile, the separate
[isolated profile-composition preview](DOCTOR.md#preview-an-existing-profile-without-editing-it)
can check whether the proposed overlay composes with that profile's current
patch layers without running an Agent or writing its generated root file.
It is not a live installation test.
The preview can optionally write a **new-only** reviewed patch via
`--out-overlay ABS_NEW_FILE` outside the profile home. This is still only an
export; inspect it privately before choosing to use it. If you later start
`dsh --profile web --patch ABS_NEW_FILE`, that is a separate real-profile host
operation: back up the profile first, because the installed host prepares and
rewrites its generated `cordis.yml`, and its plugins may load. The preview does
not run this command for you.
If your trusted installation has a `web` profile, the separate
`npm run compat:deepseek-web-profile -- --help` check goes one step beyond
composition: it boots a disposable copy of that selected bundle/patch stack
with a temporary Loader overlay, drives one fixed in-memory native read through
a synthetic Agent, and verifies its shadow ledger plus clean exit. It requests
no paid model and does not target the real profile for writes. It intentionally executes those selected
plugins, so read the [safety scope](DOCTOR.md#preview-an-existing-profile-without-editing-it)
and [dated validation](VALIDATION-DEEPSEEK-SELECTED-WEB-TOOL-T002.md) first.

Build ReflexMesh with `npm ci --ignore-scripts` and `npm run build`. Back up the
profile you intend to change, then add an insertion to that profile's
`cordis.patch.yml`; no installer changes your settings automatically:

```yaml
- insert:
    - id: reflexmesh
      name: 'file:///C:/tools/reflexmesh/adapters/deepseek-loader-plugin.mjs'
      config:
        dbPath: 'C:\ReflexMeshData\shadow.sqlite'
        tenantId: 'local'
        scope: 'my-project'
        intentMode: 'off'
```

Replace both paths. `name` is a module **file URL**; `dbPath` is an absolute local
filesystem path in a private directory. On Windows, YAML single quotes preserve
backslashes. For spaces or non-ASCII names, generate the URL rather than guessing
its escaping:

```powershell
node --input-type=module -e "import { pathToFileURL } from 'node:url'; console.log(pathToFileURL(process.argv[1]).href)" 'C:\tools\reflexmesh\adapters\deepseek-loader-plugin.mjs'
```

Use a new scope when changing deployment or evidence policy. The explicit
`insert` is important: a top-level entry without it attempts to patch an existing
plugin and can be skipped when no such ID exists. Restart the chosen profile
normally to load startup-only configuration. Remove this insertion and restart
to detach the observer; existing ledger records are not deleted.

This entrypoint is deliberately **abstain-only**. It neither inherits ambient
`REFLEXMESH_PROVIDER` settings nor loads a model key. An escalation stating that
the provider is unavailable is expected, not a claim that the host tool failed.
The existing programmatic [plugin factory](DEEPSEEK-HOST.md) remains available for
trusted code that supplies an explicitly configured boundary/provider.

After a host call, inspect the ledger without starting any model or tool:

```powershell
npm run evidence -- list --db 'C:\ReflexMeshData\shadow.sqlite'
npm run evidence -- inspect --db 'C:\ReflexMeshData\shadow.sqlite' --key KEY_FROM_LIST
```

## Explicitly opt into a selected task summary

Change only `intentMode` to `'explicit-summary'`, then begin the selected user's
message with a short first line such as:

```text
ReflexMesh-Intent: Read the selected example file; do not change files or deploy.

Other message text is not selected as ReflexMesh task evidence.
```

The source observes the real `agent/inbox/claimed` event, not session history.
It selects only a producer-declared user message whose first content block is
text and whose first line has the explicit marker. Each newly claimed user input
invalidates that agent's prior selection before validation. Missing, oversized,
suspicious or unknown-source input cannot silently retain an old task. Confirmed
plugin context additions are not treated as replacement user tasks. The existing
2048-byte summary limit and
conservative withholding rules apply; they are not a comprehensive privacy or
secret scanner.

Evidence is tied to the actual Agent object, its session and current turn, with
a read-time TTL. Other agents do not inherit it. Turn boundaries and disposal
clear the in-memory selection; expiry prevents reuse, not guaranteed physical
erasure at a wall-clock deadline. The execution ledger stores only the receipt and
digests, not the selected text or full prompt. The host may separately persist
its own conversation under its own configuration; this observer does not control
that storage.

`source.kind=user` is a producer declaration, **not independent authentication**.
Use this mode only with a trusted host ingress. A top-level receipt is `host-declared`,
not proof of human identity, authorization or full-context understanding. The
official subagent driver also wraps delegated text as `source.kind=user`; a
child with subagent-origin or parent-session metadata is therefore conservatively
`model-reported`, with unverified freshness and null envelope timestamps. A
private local TTL still limits reuse, but does not verify the original task's
age or authorship. Child summaries never inherit the parent's selection. A
claimed message may subsequently be rejected or transformed by the host; the
receipt describes the claimed summary, not the complete final model prompt.

During shutdown, stop new host dispatch and settle/cancel active host work first.
The plugin gives already accepted calls a five-second result-reception window
by default. An optional `shutdownResultWaitMs` in this Loader configuration
sets that window to a safe integer from 0 to 60000 milliseconds; 0 closes it
immediately. After the window, calls without a result remain **missing** in the
ledger and appear in read-only attention. The observer never cancels or retries
the host tool, fabricates a result, or treats absence as proof of no effects.
Without the optional fenced drain deadline below, it still waits for any
in-flight admission or captured-result write before closing its ledger.
`reflexmeshObserverReady.shutdownMissingResults` reports
the live number abandoned at shutdown, including while storage work still
prevents completion. The read-only `shutdownDrain` getter returns a frozen
scalar snapshot: `closing`, `resultWindowClosed`, `pendingBefore`,
`pendingResults`, `pendingAfter` and `missingResults`. Counts reveal no call,
Agent or result payloads. If the result window closes with admission or
captured-result storage pending, one fixed
`reflexmesh_shadow_shutdown_drain_pending` warning is emitted; it means
pending at that instant, not necessarily permanently hung. `observerDrained`
means observer storage work actually drained, not that every host call
produced an outcome. By default, `kernelClosed` becomes true only after that
drain. A custom caller-owned before/after callback that never settles can
still prevent safe closure; do not interpret the warning as permission to
force-close its ledger.
The product Loader additionally supports optional `shutdownDrainWaitMs` (a safe
integer from 0 to 60000). If configured, this second window starts **after**
the result-reception window closes. When its deadline finds unfinished Loader
storage callbacks, a Loader-owned synchronous SQLite access fence is revoked
before those callbacks are detached and the kernel closes. A late continuation
cannot read or write that closed kernel. Without this option, the existing
wait-for-actual-drain behavior remains. The option does not cancel an underlying
callback, host tool, model request or blocking JavaScript/SQLite operation.
Only the Loader's built-in `TaskAwareBoundary` has this fenced-storage contract;
the programmatic plugin with arbitrary caller-owned storage does not.
An admission detached at the deadline may let the host's own permission
waterfall continue without a ReflexMesh observation; this is an explicit
evidence gap, not an observer-owned authorization decision.

`shutdownDrain` then includes `storageRevoked`, `detachedBefore` and
`detachedAfter`. They are deadline-isolation counts, separate from
`missingResults`: a detached admission is not an accepted missing-result call,
and a detached result callback may already have committed its observation.
`reflexmeshObserverReady.storageRevoked` is true only if this deadline triggered.
If any callback was detached, `observerDrained` stays false even though
`kernelClosed` can safely become true after the fence is revoked. A fixed
`reflexmesh_shadow_shutdown_storage_revoked` warning reports this event once;
it neither proves a host effect was absent nor permits a retry. Keep the
readiness reference captured before unload to inspect these fields.
An event-loop-blocking callback can prevent the timer from running, so the
configured value is not a hard wall-clock guarantee.
For an account-free check against a trusted installed Harness 0.1.2-rc.1,
run `node scripts/real-host-compat.mjs --host deepseek --deepseek-mode
observer-fence --deepseek-package-root PATH_TO_DSH` after `npm run build`.
The [installed-host report](VALIDATION-DEEPSEEK-FENCE-HOST-T001.md) describes
the injected pending result-storage callback, the native Agent result and
the evidence limits. This probe uses only a disposable synthetic profile.
To test callbacks that **never** resolve, run the same command with
`--deepseek-mode observer-pending-before` and then
`--deepseek-mode observer-pending-after`. Both use the installed Loader in a
disposable profile and require the Agent to exit naturally. The first checks
that a detached admission creates no decision or false missing-result count;
the second keeps the admitted decision but leaves its unobserved result
`missing` and visible to `evidence attention`. These checks do not cancel a
native tool or certify an event-loop-blocking callback, arbitrary custom
storage, default-profile setup or real-model transport. See the
[permanent-pending validation](VALIDATION-DEEPSEEK-PERMANENT-PENDING-T001.md).
To examine the different case where a **native tool body itself does not
return**, use the separately supervised, account-free check:

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-missing-result --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

An optional `--out-dir ABSOLUTE_NEW_DIRECTORY` keeps a new, synthetic lesson directory with its
ledger, receipt and copyable read-only `attention` / `inspect` commands; existing
paths are never overwritten. Without this option the temporary fixture is
removed after verification. The check requires a real admission and a pending
native tool, then unloads the observer with a zero result-reception window. It
reads the missing-outcome ledger both before and after its supervisor terminates
**only the isolated child it started**. A passing observer check explicitly
means the native tool and Agent did **not** complete naturally. Cancellation is
not assumed to abandon the tool body, and a timeout, early exit or forced stop
without confirmed readback is not a pass. This does not exercise a user profile,
real model, arbitrary tool side effects or a general host timeout policy.
See the [dated missing-result validation](VALIDATION-DEEPSEEK-MISSING-RESULT-T001.md)
for the exact local evidence and exclusions.
An integration that monitors unload should capture the readiness object
**before** starting Loader disposal. Cordis may remove the service during
unload, so a fresh `ctx.get('reflexmeshObserverReady')` is not a reliable way
to discover a pending drain; getters on the previously captured object remain
live. Do not treat this object as a host-tool cancellation handle.

## Reproduce the isolated CLI/Agent probe

```bash
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode agent-cli --deepseek-package-root /absolute/path/to/node_modules/@deepseek-ai/dsh
```

Only select a trusted installation: this runs its code. The probe creates a
temporary cwd and `DSH_HOME`, an empty-bundle profile, an explicitly enumerated
plugin set, and a restricted synthetic reader. It invokes the installed native
CLI, actual Loader, Agent loop and ToolRuntime. It does not load the default
base/settings/credentials/telemetry bundles or change a real profile.
The profile patch contains only the fixed host/fixture rows; the proposed
ReflexMesh Loader row is generated by the same helper used by the profile
preview, saved separately, and passed to the installed CLI with `--patch`.
The probe checks that the base patch lacks the observer and that the active
Loader entry came from that CLI overlay. This verifies the overlay boot path
with synthetic transport, not your selected profile or an arbitrary exported
file. See the [dated overlay-boot result](VALIDATION-DEEPSEEK-OVERLAY-BOOT-T001.md).

The probe checks the active Loader entry and temporary profile configuration
tree, not just the generated files. At exit it requires both the observer-drained
and kernel-closed receipts, plus Node's natural `beforeExit` event. Exit code 0
alone is insufficient because this host can force exit after a cleanup deadline.
These checks prove this observer's cleanup for this task, not independent
correctness of every host plugin.

The host's LLM service receives an in-memory **synthetic adapter** that requests
the fixture tool and only emits its final marker after observing the matching
tool result. This is not real inference and is not a second ReflexMesh provider.
ReflexMesh itself remains abstaining. A successful receipt explicitly states:

```json
{
  "evidenceLevel": "cli_agent_loop",
  "agentLoopExercised": true,
  "agentE2E": false,
  "modelInference": false,
  "modelTransport": "synthetic_adapter",
  "classification": "abstain"
}
```

The native tool-only probe remains the default when `--deepseek-package-root` is
supplied without `--deepseek-mode agent-cli`. Neither probe certifies a real model,
arbitrary installed plugins, concurrent whole-host teardown, or the complete
cross-host cancellation/restart/subagent matrix. See the [validation record](VALIDATION-AGENT-LIFECYCLE.md)
and [iteration gates](ITERATION-STATE.md).

A separate authorized [real-model validation, t001](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md)
passed one isolated Agent/tool round trip on the exact PR #5 baseline. It used
the official DeepSeek adapter, two bounded remote requests and a synthetic
in-memory reader. That one-off test does not change the account-free probe
above, enable remote calls in doctor/CI, or certify an arbitrary user profile.

For two additional installed-host scenarios covering concurrent tool bodies,
task replacement, cancellation and followup, use the
[lifecycle-matrix guide](DEEPSEEK-LIFECYCLE.md). These scenarios deliberately use
synthetic model transport, retain zero labels and keep the full lifecycle gate
open.

The separate [subagent-isolation guide](DEEPSEEK-SUBAGENTS.md) explains the
official in-process spawn path, repeated call IDs across distinct Agents,
missing child summaries and model-reported child provenance. It does not certify
all delegation plugins or process restart.
