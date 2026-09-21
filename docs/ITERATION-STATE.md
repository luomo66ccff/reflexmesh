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

## Current increment: Claude first-run diagnosis and direct generated setup

`feat/claude-first-run` is based on PR #11's `36b7320`, not merged main. This
increment does not merge or retarget any existing PR. Check its published exact
head and remote CI separately from the earlier stack members.

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

## Unfinished acceptance gates

| Gate | Remaining work |
| --- | --- |
| Actual host lifecycle | Default-profile compatibility; cross-host concurrency, cancellation, restart, shutdown and full subagent identity matrix. DeepSeek has fixed synthetic-transport parallel/cancel/task-replacement/followup and official sequential spawn isolation coverage plus one separate authorized real-model round trip. In-process rejected admissions and observed Claude cross-process pairing conflicts are covered, with explicit pre-reservation limits. Installed Claude native Read/prompt/pre/post/Stop and injected duplicate-observer rejection now pass with local synthetic transport; broader Claude concurrency/cancellation/subagents, forked/resumed children, restart and timeout policy remain open. |
| Independent providers | Runtime-validated capability declarations, a genuinely independent non-fixture provider, fail-before-egress conformance and binding propagation. See [design](PROVIDER-CONFORMANCE.md). |
| Useful comparison | Versioned labeled datasets, usable eval/replay/compare reports, separately bound champion/challenger deployments; no automatic truth labels. |
| Safe operations | Retention preserving idempotency tombstones, independently authenticated recovery evidence, lease/cancellation budgets, migration and privacy/load testing. |
| Easy onboarding | DeepSeek and Windows Claude read-only first-run diagnostics are implemented. Claude's generated direct production hooks pass isolated installed-CLI checks in default-off and explicit-summary modes. Other hosts/platforms and real user-profile first-run acceptance remain open. No silent credential/settings changes. |
| Release confidence | No known unresolved blocker within declared support scope; tested exact heads, independent review and honest exclusions. Never claim absence of all possible bugs. |

Next increments should close the host lifecycle gaps before broadening the
provider surface. No dashboard, new agent framework, automatic writes, or
automatic threshold loosening is part of this plan. Missing real-host credentials
or a new external authority requirement should be stated precisely; it does not
justify fabricated evidence or abandoning independently verifiable work.
