# Outcome admission pairing — 2026-09-22

Scope: in-process DeepSeek and generic function-call observers, based on
`11c6407e910ab5216195dad02830f297fd373573` (PR #8). The new worktree is
`fix/deepseek-outcome-admission`; this does not change or certify merged main.
Dates in this report use Asia/Shanghai; the recorded CLI receipts use UTC.

## Reproduced defect

An old decision could exist without an outcome, for example after an observation
write failed. A new task could reuse its session/agent/call ID and tool arguments.
Although `before` rejected the changed task as an idempotency conflict, both
in-process observers still attempted `after`. The action-only check in `after`
then allowed the new result to be attached to the old task's decision.

Before the fix, seven new regressions failed: three real SQLite-journal cases
(DeepSeek success, function-call success and function-call exception), plus
four DeepSeek mid-call retargeting cases. The journal cases showed new
`succeeded`/`unknown` observations added to the old row despite rejected task
admission. The retargeting tests used callback fixtures, not a claim that the
official host normally mutates those fields. A fifth session-object replacement
case was added with the fix.

Installed `dsh-agent-loop` 0.1.2-rc.1 passes model `block.id` directly to
`exec.callId` (installed `lib/index.js`, lines 120–130), without a turn suffix.
This source inspection establishes why a host-supplied ID is not a substitute
for pairing each observation. It does not prove a real model reused an ID in
this test, or certify resumed/forked children.

## Product behavior

- The function-call wrapper records outcomes only after that invocation's
  before-observation resolves. Failed intent resolution/admission still leaves
  the host callback's one execution and original return/error unchanged.
- DeepSeek keeps a digest of the accepted normalized call and the exact optional
  Agent/session object references. Result-time identity must still be valid and
  all those bindings must match; no fallback to an old identity is introduced.
- A rejected or pre-dispatch-aborted observation releases its slot immediately.
  It does not consume the 256-call capacity or leave disposal waiting for an
  outcome that cannot be safely associated. Accepted calls still drain through
  their terminal result and queued journal write.
- A new selected task does not invalidate the result of an already accepted
  earlier tool invocation. Post-dispatch cancellation remains reported UNKNOWN.

Resolved admission means **matching semantic evidence**, not a newly acquired
lease. The SQLite request digest is checked before replay/busy/unknown handling
and includes task receipt, pack and deployment binding. Same-semantic in-flight
or UNKNOWN records may still receive host-reported outcomes; tests verify this
does not change run state, epoch, stored decision, audit or labels, and an
UNKNOWN record continues to return `recovery_required` afterwards.

No SQLite schema, retry budget, authorization, remote-provider configuration,
label policy or host tool execution rule changed. The adapter remains shadow.

## Verification

Root verification on Windows:

| Check | Result |
| --- | --- |
| Dependency install | `npm ci --ignore-scripts` passed |
| Node 24.19.0 `npm run check` | 259 tests; 258 passed, 0 failed, 1 expected Windows symlink skip |
| Portable Node 22.23.2 full suite | Same 259/258/0/1 counts |
| Four offline demos | `demo`, `demo:durable`, `demo:recovery`, `demo:evidence` passed |
| New focused offline regressions | 15 admission/lifecycle tests and 3 probe-entry tests passed |
| Installed native admission probe | 8/8 assertions passed, no model inference |
| Existing installed CLI lifecycle matrix | 17/17, synthetic transport; receipt `2026-09-21T16:01:59.412Z` |
| Existing official sequential spawn probe | 12/12, synthetic transport; receipt `2026-09-21T16:02:00.974Z` |

The Node 22 test leaves runtime warnings enabled and accepts only its exact
built-in experimental SQLite notice on negative CLI invocations. It does not
ignore arbitrary stderr. The inherited per-file test concurrency limit and all
explicit SQLite process-race tests remain unchanged.

A separate narrow read-only reviewer found no blocker. Root verified the
request-digest ordering, added explicit in-flight/UNKNOWN controls, strengthened
the installed probe's new-task/action/result-digest assertions and cleanup
failure handling, and reran the final checks. This is not a full security audit.
Remote CI evidence belongs to the published PR's exact head; local tests alone
are not a remote CI claim.

## Reproduce the installed native regression

```bash
npm run build
node scripts/deepseek-admission-probe.mjs /absolute/path/to/node_modules/@deepseek-ai/dsh
```

Only select a trusted installation: the probe imports that code. Supported
packages are `dsh`, `dsh-tools`, `dsh-system-prompt` 0.1.2-rc.1 and Cordis 4.0.2.
Missing/unsupported packages and invalid arguments produce fixed failure
receipts. The fixture loads Cordis, SystemPrompt (runtime context disabled) and
native ToolRuntime, not a CLI profile, Agent loop, model route or user settings.

The first synthetic tool call is assessed successfully, then the fixture
deliberately injects one **journal failure before writing** its outcome. The
second call reuses its IDs and arguments with a different task. The native host
executes both bodies and returns their distinct fixed values, but the second
admission conflicts and the entire old row remains unchanged, with no outcome
or label. A third, new call ID is the positive control: its new task receipt,
exact action digest and native-result digest must all match its observation.
The probe flushes and unmounts the observer before closing its in-memory ledger;
cleanup errors cannot produce a passed receipt.

The receipt is `evidenceLevel:native_tool_outcome_admission`, `agentE2E:false`,
`modelInference:false`, `classification:synthetic_classification`. Mock values
are not model predictions, accuracy measurements or a new decision provider.

## Historical data and exclusions

Historical outcomes are not rewritten: the old ledger lacks enough invocation
identity to distinguish a valid outcome from a misattributed one reliably.
Treat earlier same-ID/conflict histories as requiring independent evidence.
Do not retry tools, clear UNKNOWN tombstones or manufacture new truth labels to
repair the presentation. Use unique host call IDs for distinct invocations.

This fix does not add a cross-process receipt handshake to separate Claude hooks
or authenticate MCP client-reported results. A reused-ID conflict/outcome audit
for those separate-process paths remains open. Full DeepSeek fork/cold-resume,
restart, cancelled-child, default-profile and cross-host compatibility gates
also remain open. No user profile was modified and no remote model calls were
made in this increment.
