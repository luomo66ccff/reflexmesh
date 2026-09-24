# DeepSeek lifecycle checks: concurrency, cancellation and task replacement

This opt-in check runs the **installed DeepSeek Harness 0.1.2-rc.1** CLI,
profile Loader, Agent loop and ToolRuntime. It uses a deliberately synthetic
model adapter and restricted in-memory tools. It is not remote inference, a
benchmark, a default-profile check or a complete cross-host lifecycle matrix.

```powershell
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode lifecycle-matrix --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

Select only a trusted installation: the command executes its code. Each fixed
scenario uses a separate temporary home/profile/cwd and ledger, an empty bundle
list, explicitly selected plugins and no user account or transcript discovery.
The usual offline CI does not install these host packages or call a model.

## The two different scenarios

| Scenario | What must be demonstrated |
| --- | --- |
| Parallel tools and task replacement | Two concurrency-safe tool bodies overlap and settle out of order; one succeeds and one throws. Their outcomes remain attached to the correct call and task. A subsequent steered task receives its own selected-summary digest. |
| Cancellation and followup | The first tool body starts, the real Agent is cancelled, and that body returns. The host's post-dispatch `ABORTED` result is recorded as unknown without retry. A followup starts a new turn with fresh task evidence and completes. |

Body completion order and result notification order are not interchangeable:
this host may execute in parallel while committing results in model order.
The check must prove overlap at body entry, not infer it from two final rows.

Both scenarios also check actual Agent/session identity, per-call outcomes,
zero labels and product cleanup before natural exit. A zero process exit code
alone is insufficient. The existing [single-task synthetic probe](DEEPSEEK-AGENT.md)
and [dated real-model test](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md) remain separate
evidence with different scopes.

## Why cancellation is unknown

The installed ToolRuntime uses `error.info.code = ABORTED` after a tool body has
been invoked. It waits for that body to settle, and cancellation can supersede
even a successful return. ReflexMesh therefore records **harness-reported
unknown**, not evidence that nothing happened or permission to retry.

`ABORTED_BEFORE_DISPATCH` and ordinary `isError: true` results retain the
host-reported failed status. Error text is not parsed to guess cancellation.
Reported failure is not a rollback guarantee or ground-truth label either.

The shadow decision row can already be `completed` while the separately
reported host outcome is `unknown`. Doctor now warns for either an unknown
execution row or unknown reported host outcome; it does not rewrite the
decision row, create an execution tombstone or grant replay permission.

Result identity, call and bounded evidence are captured during the synchronous
host result notification. Asynchronous journal work uses that private snapshot;
a later listener cannot silently rewrite it or invalidate its already-checked
identity. An identity invalid **before** the notification is still rejected.
The observer does not freeze or mutate the host's objects. Raw result data is
not persisted; the ledger retains only its digest and observation metadata.
The one-megabyte limit applies to the accepted serialized result, not a hard
CPU or temporary-memory limit on traversing arbitrary host objects.

## Limits

No default-profile compatibility, real subagent, process restart, forced kill,
missing-result recovery or host-tool timeout-policy validation is implied. The
installed host delegates tool timeout policy to a separate plugin; it is not
loaded by these minimal scenarios. The host must quiesce its own work before
unloading the observer. ReflexMesh now has a separate bounded result-reception
window during observer shutdown: after its deadline, an accepted call without
`tools/result` stays **missing** and gets a fixed diagnostic. This is not an
`ABORTED` report, proof of absent effects or permission to retry. Already
running admission/result-storage callbacks still drain before the kernel
closes; one that never settles can still leave shutdown pending. The bounded
window is covered by synthetic observer/Loader tests, not these installed-host
scenarios. The separate [installed observer-teardown probe](VALIDATION-DEEPSEEK-TEARDOWN-T001.md)
now exercises that absence **at unload** with a late host result and natural
Agent exit. It does not test permanent result absence or indefinitely hung
admission/storage callbacks. See [shutdown validation](VALIDATION-DEEPSEEK-SHUTDOWN-T001.md).

Existing historical observations are not migrated or reclassified. The new
ABORTED mapping applies only to newly observed results. Use independent host
evidence when reviewing an older failed observation; never automatically retry
it because its old status says failed.
