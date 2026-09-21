# ReflexMesh iteration state

## Long-term objective and completion boundary

Keep iterating toward a distinctive, useful and easy-to-start semantic decision
runtime, with no known unresolved defects within a clearly tested release scope.
The user objective is broader than this increment. A green suite or one PR does
not prove the project bug-free or finish the whole objective.

The product direction remains **one contract, durable evidence, multiple
harnesses**. Its practical value is explaining what was decided, from which
limited task evidence, under which immutable provider/pack binding, separately
from what a host reports happened. Replaying policy must never run a tool.

## Completed foundation

- Recovery review and task-evidence PRs #2 and #3 are merged. Their final main
  CI run [35511931142](https://github.com/luomo66ccff/reflexmesh/actions/runs/35511931142)
  passed Ubuntu/Node 22 and Windows/Node 22/24. This is baseline evidence, not
  CI evidence for later commits.
- Preserve shadow defaults, host-owned authorization, immutable bindings,
  minimized task summaries, provenance separation, and UNKNOWN no-retry rules.
- Historical narrow Codex/Claude live probes remain dated evidence in
  [VALIDATION-REAL-HOSTS.md](VALIDATION-REAL-HOSTS.md), not a full host matrix.

## Reviewed increment: host evidence experience

Published for review as [PR #4](https://github.com/luomo66ccff/reflexmesh/pull/4).
The original development worktree remains preserved; integration lives on
`feat/host-evidence-experience`. Check the PR's exact-head CI before merging.

- Read-only, bounded evidence `list` / `inspect`, including explanations,
  task coverage, outcome provenance, and recovery uncertainty.
- Credential-free `demo:evidence` walkthrough, explicitly synthetic.
- DeepSeek Cordis plugin wrapper and opt-in installed native tool-pipeline
  probe, explicitly **not CLI/Agent/model E2E**.
- Actual validation, regressions found and evidence limits are recorded in
  [VALIDATION-HOST-EXPERIENCE.md](VALIDATION-HOST-EXPERIENCE.md).

## Reviewed increment: DeepSeek CLI and Agent-loop integration

Published as [PR #5](https://github.com/luomo66ccff/reflexmesh/pull/5) on
`feat/deepseek-agent-lifecycle`, stacked on the host-evidence branch. Do not
assume either branch has merged; verify current base, exact head and checks
before any merge. Head `a3dfe39b86b0b4a7480486b4c76e6e60e15eb3b7` passed
[CI 35610401760](https://github.com/luomo66ccff/reflexmesh/actions/runs/35610401760)
on Ubuntu/Node 22 and Windows/Node 22/24 after a test-only SQLite-warning fix.

- Loader-ready product entrypoint owns its ledger and awaits accepted outcomes
  before closing it. No custom identity callback or implicit provider credential
  lookup is needed. It remains shadow and abstain-only.
- Default task capture is off. Explicit mode projects only a selected first-line
  summary from the current producer-declared user inbox claim, scoped to the
  actual Agent/session/turn/signal and bounded by TTL/capacity.
- Root verification exercised the installed 0.1.2-rc.1 CLI, profile Loader, Agent
  loop and ToolRuntime using a synthetic model adapter and fixed in-memory tool:
  12/12 assertions, including actual Loader binding and exit-time cleanup proof.
- Windows/Node 24 local check: 208 tests, 207 passed, one intentional symlink
  skip. That suite and the synthetic probe do not imply real-model inference.
- Setup and honest evidence limits: [guide](DEEPSEEK-AGENT.md) and
  [validation](VALIDATION-AGENT-LIFECYCLE.md). Earlier reports remain unchanged.

## Reviewed increment: first-run diagnosis and isolated real-model evidence

[PR #6](https://github.com/luomo66ccff/reflexmesh/pull/6),
`feat/first-run-doctor`, is based on PR #5's `a3dfe39` head, not merged main.
Exact head `7811d35a6ebe5565c80c614fe896906d7a9f0294` passed
[CI 35613953280](https://github.com/luomo66ccff/reflexmesh/actions/runs/35613953280):
Ubuntu/Node 22 passed 220/220 tests; Windows/Node 22 and 24 each passed 219 with
one expected symlink skip. All four offline demos passed in all three jobs.

- New `npm run doctor -- --help` entrypoint works before build, checks explicit
  installation/configuration, and prints a safely escaped Loader insertion.
  No profile discovery/editing, credentials, host startup or database creation.
- Prerequisites, bounded historical evidence and unverified live loading remain
  separate. Human and JSON results retain outcome provenance and UNKNOWN
  warnings; no success observation becomes permission, retry or a truth label.
- Local final check: **220 tests, 219 passed, 0 failed, 1 expected Windows
  symlink skip**; four offline demos passed. Installed synthetic Agent probe
  passed **12/12** after shared configuration/installation extraction.
- Separately, user-authorized real-model testing of exact product baseline
  `a3dfe39` passed **11/11** assertions: two official DeepSeek HTTP requests,
  one in-memory tool, matching tool result in request 2, real final answer,
  exact Agent/task binding, one harness observation, zero labels and natural
  exit after observer/kernel closure. No user profile was modified.
- Reports: [doctor](VALIDATION-FIRST-RUN.md) and
  [real-model t001](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md). The latter proves
  one isolated model-driven tool round trip, not the whole lifecycle gate or
  a second ReflexMesh decision provider.

## Reviewed increment: DeepSeek cancellation-safe lifecycle evidence

`feat/deepseek-lifecycle-matrix` is based on PR #6's `7811d35`, not main.
Published as [PR #7](https://github.com/luomo66ccff/reflexmesh/pull/7). Exact head
`d2073c8790e25d4310cb9b53e87406286ef4828d` passed
[CI 35616804863](https://github.com/luomo66ccff/reflexmesh/actions/runs/35616804863)
on Ubuntu/Node 22 (231/231) and Windows/Node 22/24 (230 passed, one expected
symlink skip each), plus four offline demos per job. The stack remains unmerged.

- Native post-dispatch `ABORTED` now produces harness-reported unknown instead
  of collapsing cancellation into plain failure. Current identity/call/result are captured during
  synchronous result notification, before later listeners can change them.
- Doctor warns for unknown host outcomes even when a shadow decision has
  completed. No execution permission, automatic retry, labels or historical
  data migration were added.
- Root reproduced three observer ordering/classification failures and one
  missing diagnostic before fixing them; independent review checked the fixes.
- New installed CLI/Agent `lifecycle-matrix` probe passed **17/17** after review:
  overlapping tools and a single task replacement; body-entry cancellation,
  unknown observation and followup in a new turn; exact bindings and cleanup.
  Transport is synthetic, not a new real-model or default-profile claim.
- Local full suite: **231 tests, 230 passed, 0 failed, 1 expected Windows skip**;
  four offline demos passed. Previous installed probes passed 13/13 and 12/12.
- [Lifecycle guide](DEEPSEEK-LIFECYCLE.md) and
  [validation report](VALIDATION-DEEPSEEK-LIFECYCLE.md) record exact scope,
  review corrections, migration limits and untested paths.

## Reviewed increment: official subagent isolation and honest provenance

`feat/deepseek-subagent-isolation` is based on PR #7's `d2073c8`, not main.
Published as [PR #8](https://github.com/luomo66ccff/reflexmesh/pull/8); verify its
current exact-head checks before any merge, not an earlier stack member's CI.

- Fixed a reproduced source upgrade: official child prompts wrapped as user
  messages now remain model-reported/unverified. Private resolver TTL remains
  enforced without inventing human-origin or independent freshness evidence.
- Root verified actual installed CLI/Loader/Agent and official in-process spawn
  of two sequential children with synthetic model transport: **12/12**. Parent
  and children reuse a call ID but preserve exact task, action and result
  bindings, including per-call native payload digests and zero labels.
- Source-shaped regressions also cover shared signals, same-ID replacement
  objects and late disposal without inheriting or clearing another task.
- Final local suite on Node 22.23.2 and 24.19.0: **241 tests, 240 passed,
  0 failed, one expected Windows symlink skip**; four offline demos passed
  before the test-only CI follow-up. Existing lifecycle matrix rerun:
  **17/17**. Final narrow independent review found no remaining blocker.
- [Subagent guide](DEEPSEEK-SUBAGENTS.md) and
  [validation](VALIDATION-DEEPSEEK-SUBAGENTS.md) explain source APIs, exact
  assertions, historical-record limits and untested fork/restart/default-profile
  paths. No schema, authorization, retry or label behavior was broadened.
- Initial PR #8 Windows/Node 22 CI exposed a SQLite startup BUSY during the
  existing four-process race. Its exact phase was not logged, and 96 local
  rounds on the same Node version did not reproduce it. Added fixed phase
  diagnostics and a controlled lock-exhaustion/no-admission regression; limited
  unrelated test-file concurrency while preserving all explicit process races.
  No production SQLite code, busy budget or existing deadline was changed.
  The old failure and uncertainty remain recorded in the validation report.

## Reviewed increment: invocation-bound outcome admission

`fix/deepseek-outcome-admission` is based on PR #8's
`11c6407e910ab5216195dad02830f297fd373573`, not merged main. It preserves the
existing stack and does not change any PR's merge state.

Published as [PR #9](https://github.com/luomo66ccff/reflexmesh/pull/9). Exact head
`f89955848246508b88a06877bbf9ae208a36c940` passed
[CI 35623874475](https://github.com/luomo66ccff/reflexmesh/actions/runs/35623874475):
Ubuntu/Node 22 passed 259/259; Windows/Node 22 and 24 each passed 258 with one
expected symlink skip. All four offline demos passed in all three jobs.

- Root reproduced new-task outcomes being attached to an old same-ID decision
  even though its before-observation had rejected the task conflict. Fixed both
  in-process DeepSeek and generic function-call wrappers; the host's one
  execution and original result/error remain unchanged.
- DeepSeek also checks the accepted normalized call digest and exact optional
  Agent/session object references at result delivery. Failed observations
  release their slots; normally accepted late results retain their old task.
- Root verified the new installed Cordis/ToolRuntime probe **8/8**, with an
  explicitly injected first-outcome journal failure, same-ID new-task conflict,
  unchanged old row and new-ID positive control. This is native tool-only
  evidence, not CLI/Agent/restart or real-model certification.
- Final local Node 22.23.2 and 24.19.0 suites: **259 tests, 258 passed, 0 failed,
  1 expected Windows symlink skip**. Four demos passed; existing installed
  lifecycle and official spawn probes passed **17/17** and **12/12**.
- Narrow independent review found no blocker. Root added matching in-flight and
  UNKNOWN controls: host observations do not alter execution state or allow
  retries. No historical records or SQLite/permission policies were changed.
- [Validation, reproduction command and historical-data limits](VALIDATION-OUTCOME-ADMISSION.md).
  Separate-process conflict/outcome pairing, full cold-resume/fork and default
  profile behavior remain unverified; no paid model calls were made.

## Reviewed increment: durable Claude hook pairing

`fix/claude-outcome-pairing` is based on PR #9's `f899558`, not merged main.
Published as [PR #10](https://github.com/luomo66ccff/reflexmesh/pull/10). Exact
head `2e59f2d7c443e38d6eeb000c1ec6c9302d3676c8` passed
[CI 35627157873](https://github.com/luomo66ccff/reflexmesh/actions/runs/35627157873):
Ubuntu/Node 22 passed 288/288; Windows/Node 22 and 24 each passed 287 with one
expected symlink skip. All four demos passed in all three jobs. The stack
remains unmerged; verify current heads/checks before any future merge.

- Root reproduced three cross-process evidence misassociation failures, with a
  late-old-result positive control. Both hook entrypoints now reserve in the
  execution ledger before task-cache access/evaluation and require a ready,
  matching receipt before accepting a result.
- Schema 3 persists pending/ready/blocked association; any duplicate pre remains
  ambiguous. Missing/early/conflicting observed events cannot revive a blocked
  key. Post uses the stored request/action/deployment, not the current task.
- Retained historical outcomes are unchanged but evidence list/inspect and
  doctor show pending/blocked association explicitly. Pairing is not execution
  authority, an UNKNOWN reset, a retry permit or a truth label.
- Root's final Windows Node 22.23.2 and 24.19.0 suites each passed **287 of 288**
  tests with **0 failures and one expected symlink skip**. The 29 new cases cover
  actual CLI processes, receipt reopen, duplicate races, process death after
  reserve, before/storage failures and schema-1/2 migration rollback.
- Four offline demos and the installed DeepSeek lifecycle/spawn/native-admission
  probes passed **17/17**, **12/12**, **8/8**, respectively. The latter probes use
  synthetic transport or native tool fixtures, not new real-model calls.
- Narrow independent review found the first-block-reason overwrite, now fixed
  and verified. See [guide](CLAUDE-HOOK-PAIRING.md) and
  [validation](VALIDATION-CLAUDE-PAIRING.md). Broader Claude app integration,
  pre-reservation failure detection, mixed-old-worker upgrades and production
  load/privacy/retention certification remain open or explicitly unsupported.

## Reviewed increment: account-free installed Claude local loop

`feat/claude-local-loop` is based on PR #10's `2e59f2d`, not merged main.
Published as [PR #11](https://github.com/luomo66ccff/reflexmesh/pull/11). Exact head
`36b73200368e81f0fcd2563d1c5687d23435a0fd` passed
[CI 35631711129](https://github.com/luomo66ccff/reflexmesh/actions/runs/35631711129):
Ubuntu/Node 22 passed 354/354; Windows/Node 22 and 24 each passed 353 with one
expected symlink skip. All four offline demos passed in all three jobs.
The stack remains unmerged; no existing PR is retargeted by this increment.

- `npm run compat:claude-local` uses installed Windows Claude Code 2.1.263,
  native Read and real hook processes with strict localhost synthetic Messages,
  separate configuration stores and no account or real model inference.
- Both root-verified scenarios passed **22/22** on Node 22.23.2 and 24.19.0.
  Normal pairing admits one exact harness outcome; an injected duplicate
  observer delivery blocks ambiguous pairing while native Read still succeeds.
  Session/call identity, successful hook responses, Stop-specific cache clear,
  minimized evidence and zero labels are checked, not inferred from exit alone.
- Local full suites on both Node versions passed **353 of 354**, with zero
  failures and one expected Windows symlink skip. Four offline demos passed.
  The 66 new tests include strict transport, falsified lifecycle/response
  negatives, policy/context refusal and bounded cleanup failures.
- Independent review found and verified fixes for two false-pass boundaries;
  final scoped review found no remaining blocker. No production adapter/kernel
  behavior changed. No real-model calls were added.
- [Guide](CLAUDE-LOCAL-LOOP.md) and [validation](VALIDATION-CLAUDE-LOCAL-LOOP.md)
  document the observed bare-mode hook omission, version-specific handshake,
  fixture-wrapper boundary and lack of OS sandbox/full host certification.

## Reviewed increment: Claude first-run diagnosis and direct generated setup

`feat/claude-first-run` is based on PR #11's `36b7320`, not merged main. This
increment does not merge or retarget any existing PR. Published as
[PR #12](https://github.com/luomo66ccff/reflexmesh/pull/12). Exact head
`967e714356e0e9f7b18b878c09d9583a4b5d1496` passed
[CI 35635660652](https://github.com/luomo66ccff/reflexmesh/actions/runs/35635660652):
Ubuntu/Node 22 passed 406/406; Windows/Node 22 and 24 each passed 405 with one
expected symlink skip. All four offline demos passed in all three jobs.

- `npm run doctor:claude -- --help` works before build. Explicit native Windows
  executable, ledger and namespace choices generate a reviewable seven-event
  production-hook settings fragment: shadow/abstain, remote disabled, summary
  capture off by default. No settings/profile/credential discovery or edits,
  host startup, database creation or history migration.
- Static prerequisites, bounded historical evidence and unverified current
  loading stay separate. Reported outcome provenance, UNKNOWN and ambiguous
  pairing warnings remain visible. Executable presence is not a version claim.
- `npm run compat:claude-setup` uses the generated env/hooks unchanged with
  direct production entrypoints and no inherited ReflexMesh deployment values.
  Root verified both capture-off and explicit-summary scenarios **17/17** on
  actual installed Claude Code 2.1.263 with Node 22.23.2 and 24.19.0. Local model
  transport is synthetic; no real-model/account/default-profile claim is added.
- Omitted-settings actual-host control correctly failed hook/ledger checks
  despite a successful native Read. Final full suites on both Node versions:
  **406 tests, 405 passed, zero failed, one expected Windows symlink skip**.
  The 52 new tests, four offline demos and prior installed wrapper probe
  (**22/22** plus **22/22**) passed.
- Review corrected ledger-length mismatch, bad cache target acceptance,
  pre-metadata UNC/device checks, missing hook entry and Windows drive-relative
  ambiguity. Root verified fixes and independent final review found no blocker.
  No execution authorization, retry, labels, schema or production hook behavior
  was broadened. [Guide](CLAUDE-FIRST-RUN.md) and
  [validation](VALIDATION-CLAUDE-FIRST-RUN.md) record exclusions and reproduction.

## Reviewed increment: trustworthy Claude failure and interruption evidence

`fix/claude-interrupted-outcomes` is based on PR #12's `967e714`, not merged
main. No existing PR is merged or retargeted; verify this increment's exact
published head and CI independently.

- Root reproduced an explicit Claude interruption flag being collapsed into
  ordinary failure. The optional boolean now maps true to harness-reported
  unknown, absent/false to failed, and invalid types to rejected observation.
  Completed shadow decisions, execution UNKNOWN, recovery, retry and labels
  remain separate; historical outcomes are not retroactively reclassified.
- Both actual Node hook CLI entrypoints pass source-shaped pre/failure process
  regressions, including conflicting reports, provenance/digests and doctor
  warnings. A late old interruption does not clear or inherit a new summary.
  These tests are not actual-host cancellation evidence.
- New `npm run compat:claude-failure` passed **19/19** on installed Windows
  Claude Code 2.1.263 with Node 22.23.2 and 24.19.0. Two fixed synthetic MCP
  bodies overlap at a barrier; real success and failure hooks bind separately
  to exact call/action/task/result evidence. Generated production hooks are
  unchanged, transport is synthetic localhost, and labels remain zero.
- Omitted-settings actual-host control correctly failed despite native tool
  completion. Full local suites on both Node versions: **482 tests, 481 passed,
  zero failed, one expected Windows symlink skip**. All 76 new tests, four
  offline demos and prior generated-setup scenarios (**17/17** each) passed.
- Scoped independent review found no remaining blocker; root verified actual
  results. [Semantics/usage](CLAUDE-FAILURE-EVIDENCE.md) and
  [validation](VALIDATION-CLAUDE-FAILURE-EVIDENCE.md) retain cancellation,
  default-profile, restart, platform and operational exclusions. No paid model
  calls or user settings changes were made.

## Reviewed increment: cold-resume evidence and attention

`feat/evidence-attention` is based on PR #13's `380b156`, not merged main.
This increment does not merge or retarget any existing PR. Published as
[PR #14](https://github.com/luomo66ccff/reflexmesh/pull/14). Its exact head
`ed8754de8b8d2fe6b30118fe781a97c2f7fd81de` passed
[CI 35641787237](https://github.com/luomo66ccff/reflexmesh/actions/runs/35641787237):
Ubuntu/Node 22 passed 539/539, Windows/Node 22 and 24 each passed 538 with one
expected skip, plus all four offline demos. That CI is not this next branch's CI.

- `evidence attention --db PATH` now gives a read-only, bounded keyset page of
  existing decision rows needing evidence review. Missing completed-shadow
  outcomes stay separate from durable UNKNOWN; model/test/host provenance is
  preserved. Pair-only reservations are explicitly excluded, ordinary failures
  are not automatically retried, and an empty list is not a health certificate.
- `npm run compat:claude-resume` passed **20/20** per scenario on installed
  Windows Claude Code 2.1.263 with Node 22.23.2 and 24.19.0. Two distinct native
  processes restore one explicitly selected synthetic session, both after a
  clean exit and after an observed/persisted tool-entry barrier followed by an
  owned-process kill. New prompts replace or clear prior cached task evidence.
- Root verified the old missing result stays unchanged and appears through the
  public attention CLI. Zero labels are created; no actual account, paid model,
  default profile or real user transcript is used. An omitted-hooks actual-host
  negative control fails despite successful native tool completion.
- The **57 new offline regressions** and four offline demos passed. Independent
  review counterexamples for history order/roles, protocol failure receipts,
  hook warnings/order and provenance wording were fixed and root-verified.
  Final full local suites on both Node versions: **539 tests, 538 passed, zero
  failed, one expected Windows symlink skip**. Exact CI receipts must be read
  from this PR's published head.
- [Guide](CLAUDE-COLD-RESUME.md) and [validation](VALIDATION-CLAUDE-COLD-RESUME.md)
  retain unattended resume, cancellation, default-profile, child/fork, platform,
  external effects and descendant-termination exclusions.

## Reviewed increment: independent provider and capability-bound evidence

`feat/independent-provider` is based on PR #14's `ed8754d`, not merged main.
Published as [PR #15](https://github.com/luomo66ccff/reflexmesh/pull/15).
No existing PR is merged or retargeted. Verify this increment's exact published
head and its own CI before any merge.

- Required immutable capability declarations and final input conformance now
  protect Jev, independent DeepSeek binary JSON estimates, fixtures and honest
  abstention. Unsupported question types fail before egress with no fallback.
- Explicit model and capability digest propagate through task-aware/durable
  wrappers, Claude pairing and public evidence. Schema 3 stays unchanged;
  historical missing fields remain null. Stop old workers and use new explicit
  namespaces/bindings rather than silently reusing prior judgments/calibration.
- User-authorized official DeepSeek synthetic decision-provider smoke passed
  **11/11**: one HTTP 200, 318 input/35 output tokens, no tools or labels,
  close/reopen replay and unsupported choice without further requests. These
  are uncalibrated model-authored estimates, not measured confidence or host
  authorization. The Loader stays abstain-only; no profile was read or changed.
- Review reproduced and fixed three JSON serialization bypass variants; both
  provider transports now reject them with zero egress/getter invocation. A
  synthetic loopback forbidden-port flake was also fixed without changing
  production transport. Root verified the corrections and scoped re-review.
- Local Windows Node 22.23.2 and 24.19.0 suites: **635 tests, 634 passed,
  zero failed, one expected symlink skip**. Four offline demos and opt-in demo
  help passed. Actual isolated Claude generated setup remained **17/17** per
  scenario and cold resume **20/20** per scenario on both Node versions, using
  synthetic model transport. Published exact-head CI is checked separately.
- A clean-head second real-provider request on `feed283` also passed 11/11;
  two requests total, zero tools/labels. Initial CI passed Ubuntu/Node 22 and
  Windows/Node 24 but Windows/Node 22 returned an unexpected generic probe
  error in an existing ignored-hooks negative control. Its exact cause was
  not logged. The follow-up preserves the failure record and assertion,
  uses OS-selected Fetch-compatible loopback ports, and adds redacted fixed
  phase/error diagnostics. Final local suites: **638 tests, 637 passed,
  zero failed, one expected skip** on both Node versions. Production provider
  code is unchanged; no additional paid call was needed. See the separate
  [t002 receipt](VALIDATION-INDEPENDENT-PROVIDER-T002.md) and final PR CI.
- [Usage](DEEPSEEK-PROVIDER.md), [contract](PROVIDER-CONFORMANCE.md) and
  [validation t001](VALIDATION-INDEPENDENT-PROVIDER-T001.md) retain migration,
  model-alias, latency, quality and full-host exclusions. No paid demo in CI.

## Reviewed increment: paired provider comparison

`feat/provider-comparison` is based on PR #15's
`102bb5bd31ac08e61a61b7ed483956b2a752977b`, not merged main. That exact base's
CI 35646673391 passed Ubuntu/Node 22 (638/638) and Windows/Node 22/24 (637
passed, one expected skip), plus four offline demos. This is historical base
evidence, not the new branch's CI. No existing PR is merged or retargeted.

- `evaluation validate/run/compare` now separates strict versioned datasets,
  independently supplied label files and distinct bound prediction artifacts.
  Local validation/comparison loads no credentials or provider factory. The
  bounded opt-in runner sends the full question contract, preserves every case,
  stops after failure/timeout/cancel, and never retries or invokes tools.
- Per-question paired deltas use the same labeled/both-successful cohort;
  available subsets, failure/missing coverage and class/provenance balance stay
  explicit. Policy disagreements may include unlabeled cases, never claiming
  false-allow/false-deny rates. No automatic winner/promotion or calibration
  transfer; source independence and origin remain operator declarations.
- New account-free `demo:comparison` explains missingness bias and can keep
  five editable synthetic JSON files in a new directory. New-only, pre-reserved
  output receipts prevent automatic same-path paid reruns, without promising
  atomic publication or remote idempotency.
- Windows Node 22.23.2 and 24.19.0: **676 tests, 675 passed, zero failed, one
  expected skip** each; **38/38 new regressions** and all five offline demos
  passed. Scoped independent review and root verification found no remaining
  P1/P2 in the new boundaries. CI now includes the fifth demo.
- User-authorized real workflow smoke on clean `ff450ca`: **14/14 assertions**,
  four HTTP 200 requests, 948 input/60 output tokens, zero tools or profile
  changes. Two deployments use the same `deepseek-flash` route and two fixed
  synthetic cases with independent equality-oracle labels; local comparison
  adds zero requests. This is not an independent-model quality/calibration
  comparison. See [guide](PROVIDER-COMPARISON.md) and
  [validation t001](VALIDATION-PROVIDER-COMPARISON-T001.md).

Published as [PR #16](https://github.com/luomo66ccff/reflexmesh/pull/16).
Exact head `d6c23c439093da984b5a6e55d2a94dc5e7888dd7` passed
[CI 35650186762](https://github.com/luomo66ccff/reflexmesh/actions/runs/35650186762):
Ubuntu/Node 22 **676/676**, Windows/Node 22 and 24 **675 passed, one expected
skip** each, plus all five offline demos. This remains historical base evidence
for the next branch, not its CI.

## Reviewed increment: read-only storage diagnostics

`feat/storage-diagnostics` is based on PR #16's `d6c23c4`, not merged main.
No existing PR is merged or retargeted. Verify the new published head's own CI.

- `evidence storage --db PATH [--scan-limit N] [--json]` reports one bounded
  schema-1/2/3 SQL snapshot, run/pair-only state samples and separate main/WAL/
  SHM logical file lengths. Truncated totals and unsupported schema tables are
  null, never invented zero counts; reusable pages are not reclaimable bytes.
- Single read transactions, projection-error rollback, fixed metadata-only
  queries and unchanged application rows/admission guards are regression-tested.
  File observations are explicitly non-atomic with SQL, read-only does not
  imply filesystem immutability, and lstat does not attest SQLite's own access.
- `demo:storage` provides an account-free synthetic completed/reviewed-UNKNOWN/
  pair-only lesson with optional new-only retained ledger. A real Windows/npm
  space-path forwarding failure was retained; direct quoted Node entrypoints
  work and are documented/tested rather than reconstructing split arguments.
- Windows Node 22.23.2 and 24.19.0 full checks: **699 tests, 698 passed, zero
  failed, one expected skip** each. **23/23 new regressions**, six offline demos
  on each Node version, clean `b1a42a9` focused tests and public persisted-ledger
  readback passed. Scoped independent review/root verification found no P1/P2
  within the new boundaries. No paid requests or real user-ledger cleanup ran.
- This is diagnostic capability, not garbage collection, space reclamation,
  authenticated review, backup/restore or closure of the operational gate.
  [Guide](STORAGE-DIAGNOSTICS.md) and
  [validation t001](VALIDATION-STORAGE-DIAGNOSTICS-T001.md) preserve exclusions.

## Reviewed increment: SQLite runtime preflight

**SQLite runtime preflight** is based on PR #17's `09bd885`.
Published as [PR #18](https://github.com/luomo66ccff/reflexmesh/pull/18);
implementation commit `46bfdb0539804faf9a358fbfe41861877c7bf0d1` passed clean-head
focused tests **8/8**. Subsequent onboarding corrections are documentation-only.
No existing PR is merged or retargeted. Persistent writable kernels and product
directory-creation entrypoints now reject affected/unknown SQLite runtimes
before touching the ledger. Read-only history, in-memory kernels, separate
DELETE-journal cache, schema and no-retry/permission guards remain unchanged.
Both doctors expose the actual in-memory probe, and `doctor:runtime` works
without a build or ledger. See [manual runtime guidance](SQLITE-RUNTIME.md).

Root verified Windows Node 22.23.2 and 24.19.0: **707 tests, 706 passed, zero
failed, one expected skip** per runtime, plus six offline demos each. The
official affected Node 22.16.0 / SQLite 3.49.1 passed all **11 negative scenario
groups**. Scoped independent review found no reproducible P1/P2. This is not
reproduction of the upstream corruption race or a database-integrity audit;
see [validation t001](VALIDATION-SQLITE-RUNTIME-T001.md). Verify this branch's
own exact-head CI independently before merge. No paid calls or user data work.

Final PR #18 head `5d86e058a37d143f04df718ffaa35a125b71b160` passed
[CI 35655623772](https://github.com/luomo66ccff/reflexmesh/actions/runs/35655623772):
Ubuntu/Node 22 **707/707**, Windows/Node 22/24 **706 passed, one expected skip**
each, six offline demos per supported job and both pinned-old-runtime jobs
with **11 negative groups**. This is historical base evidence, not backup CI.

## Reviewed increment: consistent ledger backup and offline verification

`feat/ledger-backup` is based on PR #18's exact `5d86e05` head, not merged main.
No existing PR is merged or retargeted. Publication and exact-head CI must be
verified separately from the local results below.

- New-only consistent online backup captures committed WAL records from a
  pinned read snapshot. Only its owned destination becomes a standalone DELETE
  archive; the source is not migrated, checkpointed by request or repaired.
- Strict schema/integrity/FK/hash/manifest verification, incomplete-publication
  markers, bounded child deadline/cancellation and fixed redacted failure codes.
  A full unencrypted ledger is copied; minimized output is not data minimization
  of the archive, authentication, freshness evidence or restore authority.
- Account-free `demo:backup` compares all seven tables and preserved no-retry/
  pairing behavior in a separate restored fixture, then demonstrates an old
  valid archive missing a newer UNKNOWN guard. No production restore command.
- Final Windows Node 22.23.2 and 24.19.0: **747 tests, 745 passed, zero failed,
  two symlink-capability skips** each, with all **seven offline demos** each.
  Actual affected Node 22.16.0 passes **12 negative groups** including backup
  create refusal, while read-only verification succeeds on the retained archive.
- Scoped review/root verification fixed WAL-header side effects, publication
  ordering and old-Windows stat identity compatibility; no remaining P1/P2 in
  the reviewed scope. No paid calls, user-ledger work or global runtime changes.
  See [guide](LEDGER-BACKUP.md) and
  [validation t001](VALIDATION-LEDGER-BACKUP-T001.md).

Published as [PR #19](https://github.com/luomo66ccff/reflexmesh/pull/19), exact
head `feee864a468ef6bae56bbac76a6a67e994f34a1d` passed
[CI 35659643736](https://github.com/luomo66ccff/reflexmesh/actions/runs/35659643736):
Ubuntu/Node 22 **747/747**, Windows/Node 22/24 **746 passed, one existing skip**
each, all seven offline demos and both old-runtime **12-group** negative jobs.
The new backup symlink regression executed successfully on Windows CI; only
the existing review-input skip remained. This is historical base evidence.

## Current increment: all-record ledger compaction

`feat/ledger-retention` is based on PR #19's exact `feee864`, not merged main.
The branch delivers physical compaction, **not historical evidence retention**.
No existing PR is merged or retargeted; verify the published head's own CI.

- Explicit local backup-bound preview and opt-in VACUUM preserve every supported
  table's logical contents, schema, page size and journal mode. A full streamed
  typed fingerprint keeps raw TEXT bytes and exact BigInt integers, not lossy
  decoded strings or implicit rowids.
- One connection retains an exclusive maintenance lock across initial COMMIT,
  VACUUM, post-checks and close. Real independent writer tests cover that gap in
  WAL and DELETE modes; stale source/backup and lock conflicts do not fall back.
- New-only plans and atomic attempt reservation preserve unknown outcomes after
  dispatch, process kill, I/O/publication failure or lost replies. Receipt inspect
  does not verify current ledger contents; no automatic retry or restore.
- Account-free `demo:compaction` observes **4,268,032 -> 65,536 bytes** main-file
  shrinkage after close on a synthetic free-page fixture while independently
  comparing all seven tables and checking replay/UNKNOWN/pair-only/provenance
  guards. This is not physical block allocation, secure erasure or row deletion.
- Final Windows Node 22.23.2 and 24.19.0: **777 tests, 775 passed, zero failed,
  two existing local symlink skips** each; **30/30** focused regressions and all
  **eight offline demos**. Actual affected Node 22.16.0 passes **13 negative
  groups**, including compaction apply refusal before reservation/open.
- Scoped independent review/root verification found no remaining P1/P2. Real
  disk exhaustion/power loss and large-ledger load are unverified; injected
  SQLite FULL and post-VACUUM I/O errors retain explicit uncertainty. No paid
  calls or real-user-ledger work. See [guide](LEDGER-COMPACTION.md) and
  [validation t001](VALIDATION-LEDGER-COMPACTION-T001.md).

## Unfinished acceptance gates

| Gate | Remaining work |
| --- | --- |
| Actual host lifecycle | Default-profile compatibility; cross-host concurrency, cancellation, restart, shutdown and full subagent identity matrix. DeepSeek has fixed synthetic-transport parallel/cancel/task-replacement/followup and official sequential spawn isolation coverage plus one separate authorized real-model round trip. In-process rejected admissions and observed Claude cross-process pairing conflicts are covered, with explicit pre-reservation limits. Installed Claude native Read/prompt/pre/post/Stop, injected duplicate-observer rejection, overlapping fixed MCP success/failure, and pinned isolated two-process cold resume with an explicit new prompt pass with local synthetic transport. Real cancellation/missing-hook paths beyond the tested kill barrier, broader concurrency/subagents, forked/resumed children, unattended/cross-host restart and timeout policy remain open. |
| Independent providers | Immutable declarations, independent DeepSeek binary estimate transport, fail-before-egress conformance and binding propagation are implemented and narrowly tested. Paired report tooling is implemented; representative independent-model quality/calibration, real Jev acceptance, broader host latency and migration remain open. See [contract](PROVIDER-CONFORMANCE.md). |
| Useful comparison | Versioned datasets, separate operator-declared independent labels, usable eval/compare reports and separately bound champion/challenger deployments are implemented. A real same-route synthetic smoke passes; distinct real provider/model comparisons, representative held-out labels and statistical uncertainty/quality acceptance remain open. No automatic truth labels or promotion. |
| Safe operations | Read-only diagnostics, consistent backup/verification, isolated synthetic restore/no-retry validation and explicit all-record compaction are implemented. Historical retention with archival coverage and ID/version guards, production restoration with newer-guard reconciliation, independently authenticated recovery evidence, lease/cancellation budgets, migration and privacy/load testing remain open. Compaction is not logical evidence deletion; archive verification is not freshness or restore authority. |
| Easy onboarding | DeepSeek and Windows Claude read-only first-run diagnostics are implemented. Claude's generated direct production hooks pass isolated installed-CLI checks in default-off and explicit-summary modes. Other hosts/platforms and real user-profile first-run acceptance remain open. No silent credential/settings changes. |
| Release confidence | No known unresolved blocker within declared support scope; tested exact heads, independent review and honest exclusions. Never claim absence of all possible bugs. |

The independently labeled, separately bound comparison/report workflow is now
implemented with an explicit provenance and descriptive-only boundary. Next,
prioritize explicit archival coverage and batch/tombstone contracts for actual
historical retention, beyond the implemented diagnostics, runtime gate,
backup/restore validation and all-record compaction, alongside remaining lifecycle evidence;
newly discovered lifecycle blockers take priority. Real comparative quality
requires suitable independent labels and distinct approved provider routes,
not repeated same-model synthetic calls. This sequence does not certify the broad host gate
or enlarge supported scope. See the dated [roadmap decision](ROADMAP.md).
No dashboard, new agent framework, automatic writes, or
automatic threshold loosening is part of this plan. Missing real-host credentials
or a new external authority requirement should be stated precisely; it does not
justify fabricated evidence or abandoning independently verifiable work.
