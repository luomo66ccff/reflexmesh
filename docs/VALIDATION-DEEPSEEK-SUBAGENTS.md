# DeepSeek subagent isolation and provenance validation

Date: 2026-09-21. Branch `feat/deepseek-subagent-isolation`, based on PR #7 head
`d2073c8790e25d4310cb9b53e87406286ef4828d`. This closes one declared subagent
scenario, not the [complete host lifecycle gate](ITERATION-STATE.md).

## Defect reproduced before the fix

The official in-process spawn driver wraps its delegated prompt in a user-shaped
message. The parent can have obtained that prompt from model tool arguments;
`source.kind=user` alone therefore cannot establish independent user origin.
Previously the Loader task source labeled a selected child summary
`host-declared` with `within_ttl` freshness, just like the parent.

A new regression failed on the previous implementation with actual
`host-declared` versus expected `model-reported`. The fix uses the live Agent's
trusted session header: `origin: subagent` or a present `parentSession` field
conservatively selects `model-reported`, null envelope timestamps and unverified
freshness. Private capture/expiry times still enforce the local resolver TTL,
including clock rollback and the exact expiry boundary. They do not establish
independent task freshness or add an egress-freshness guarantee to the existing
model-reported contract. A later genuine human message to a child is also
conservatively downgraded until trusted ingress can distinguish its origin.

Top-level provenance, default capture-off, shadow observation and host-owned
authorization remain unchanged. Missing child summaries never inherit the
parent's summary. There is no schema migration or rewrite of historical rows.

## Installed-host source and execution

Source inspected under the explicit trusted installation's `@deepseek-ai`
package directory, all relevant `dsh-*` packages pinned to **0.1.2-rc.1**:

- `dsh-subagent-spawn-in-process/lib/index.js`: registers the official spawn
  provider with `inheritsParentContext=false`.
- `dsh-subagent/lib/index.js`: `start` publishes a managed run; `childSessionMeta`
  records `parentSession`, `origin: subagent` and delegation depth.
- `dsh-subagent-in-process-driver/lib/index.js`: `startInProcessRun` creates
  the child through `parent.ctx.agents.create`; its driver submits the prompt
  with `source.kind=user`, waits for completion and owns quiescent disposal.
- `dsh-agent/lib/index.js`: `get` and `isOwnedBy` establish current object
  registration and runtime ownership, separately from durable lineage fields.
- `dsh-tool-subagent/lib/index.js`: the ordinary delegation tool turns
  `args.prompt` into the provider's prompt. The probe does not load this tool;
  it uses fixed synthetic prompts through the same public spawn API.

Root verification at **2026-09-21T15:27:13.699Z** ran:

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode subagent-isolation --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

Environment: Windows, Node.js **24.19.0**, npm **11.17.0**, DeepSeek Harness
**0.1.2-rc.1**, Cordis **4.0.2**, Loader **1.0.3**, timer **1.1.4**; adapter package
**0.2.0-alpha.1**. Optional subagent package names, exact versions and entrypoints
are checked before loading them. This is not verification of arbitrary packages
or the integrity of an untrusted installation.

Result: **12/12 assertions passed**. The actual CLI and profile Loader drive a
parent Agent and two sequential official spawn children, using seven synthetic
model requests and five native tool calls. The parent and both children reuse
one `callId` while retaining distinct actual session/Agent IDs.

The verifier reads the closed ledger independently and requires exactly five
rows, exact event keys and action digests, correct ready/missing summary
receipts, ready-receipt scope digests, shadow/abstain bindings, one correctly
bound native result per call, and zero labels. The selected child receipt is
`model-reported/unverified` with null timestamps; parent receipts remain
`host-declared/within_ttl`. A parent read after both child disposals retains the
original parent summary.

Native result payload digests are captured at `tools/result` and compared with
each exact raw ledger observation's ID, status, provenance and digest. The three
Agents return different fixed values, so exchanging successful results is
detectable. No raw result or task text is included in the public report.
Checks also require exact registry-object identity, runtime ownership, child
claim counts, child completion/unregistration, natural process exit, observer
drain and kernel closure. Temporary ledgers close before bounded cleanup.

The receipt remains `cli_agent_subagent_isolation`, `agentE2E=false`,
`modelInference=false`, `modelTransport=synthetic_adapter`,
`classification=abstain`. No user profile, credential or real transcript was
loaded, and no remote model request was made. Elapsed time is not a benchmark.

## Regression and review evidence

- New product regressions cover parent/child selection isolation despite shared
  signals/parent hints, returned-scope copy isolation, same-ID replacement
  Agents, late old-object disposal, delegated provenance and private TTL.
- Six probe tests cover the fixed sanitized receipt, isolated composition,
  pinned optional packages, wrong/swapped result digest rejection, missing
  installation, and report/exit agreement. They do not simulate a passing host
  run and present it as installed-host evidence.
- Independent read-only review identified the delegated-source ambiguity and
  required the payload-digest comparison; both were incorporated. Final narrow
  review found no remaining blocker. This is not a full security audit.
- `npm ci --ignore-scripts --no-audit --no-fund`: passed in the new worktree.
- Focused product/integration checks: **60/60 passed**.
- Root `npm run check`: **240 tests, 239 passed, 0 failed, 1 expected Windows
  symlink skip**. All four offline examples passed.
- Root reran the previous installed lifecycle matrix after the source fix:
  **17/17 passed**, including parent-task replacement and cancellation.
- `git diff --check`: passed. Remote CI is a separate exact-head check; it does
  not install DeepSeek or prove this installed-host scenario.

## Remaining limits and upgrade notes

No proof of forked/history-inheriting children, child concurrency/cancellation,
arbitrary delegation plugins, restarted/resumed Agents, forced termination,
timeout-policy integration, default-profile compatibility or live Linux hosts.
The separate dated real-model test covered an earlier root-only round trip and
was not rerun or expanded here. Full cross-host acceptance remains open.

The source correction applies only to future captures. Old child rows are not
automatically upgraded or reclassified; their old host-declared source is not
evidence of human origin. Restart the observer to load the fix and use a new
deployment scope when replaying previously observed events. This does not grant
retry permission, alter UNKNOWN tombstones, infer ground-truth labels or
authorize any host tool.

## CI follow-up: bounded startup contention, not a new retry policy

Initial head `264dd48d7c7e7f82c061cae091e8fe2dc4d31a12` passed Ubuntu/Node 22
and Windows/Node 24 in [CI 35619595935](https://github.com/luomo66ccff/reflexmesh/actions/runs/35619595935).
Windows/Node **22.23.2** failed the existing eight-round, four-process SQLite
startup race: one child reported `ERR_SQLITE_ERROR`, code 5, at `stage=open`.
That old diagnostic covered the entire constructor, so it did not identify
the exact SQL phase. The 13.8-second test duration was not a measurement of
one opener's lock wait.

A checksum-verified portable copy of the same official Node version passed the
unchanged full suite locally (240 tests, 239 passed, one expected skip), and
12 focused repetitions passed all 96 four-process rounds. This does **not**
disprove the CI failure or establish its precise cause. A separate controlled
exclusive-lock experiment confirmed that the existing startup path can exhaust
its busy budget and reject before admission; no production retry change was
justified by the available evidence.

The follow-up limits independent Node test files to one at a time, reducing
unrelated process/CPU/disk contention. Explicit process concurrency inside tests
is preserved, including all four racers, eight rounds and the original result
assertion. Neither the production two-second busy setting nor existing test
deadlines are increased. Fixture diagnostics now bind a fixed operation label
to the actual thrown Error and record elapsed time; a successful timeout-restore
statement cannot overwrite the failing operation's label. They emit no SQL,
paths or raw exception messages.

The journal helper's monotonic retry budget covers journal configuration, not
the constructor's initial schema read and later schema transaction as a whole.
SQLite's [busy handler](https://sqlite.org/c3ref/busy_handler.html) may return
BUSY without waiting to avoid deadlock, and a [busy timeout](https://sqlite.org/c3ref/busy_timeout.html)
does not guarantee that all competing openers eventually succeed. The old CI
failure's exact phase remains unknown; do not label this as a proven/fixed
SQLite product defect or treat startup rejection as permission to retry a tool.

A new deterministic regression holds an exclusive lock in another process until
the opening fixture has reported its failure. Its explicit 100 ms test budget
does not change the original race's default budget. It requires the fixed
schema-read phase/BUSY error and proves no admission exists after the holder
releases the lock. No fixed sleep is used to assume the lock was released.
Parent cleanup waits for owned child exits and validates the canonical temporary
directory before removal.

Root's final local checks after this test-only follow-up: Node **24.19.0**
`npm run check`, and Node **22.23.2** `node --test --test-concurrency=1
test/*.test.mjs`, both **241 tests, 240 passed, 0 failed, one expected Windows
symlink skip**. The product subagent source/observer remained unchanged from
the successful installed-host checks above. The updated remote head still needs
its own CI evidence; the earlier failed run is retained, not relabeled successful.
