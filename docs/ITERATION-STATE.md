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

## Current increment: first-run diagnosis and isolated real-model evidence

`feat/first-run-doctor` is based on PR #5's `a3dfe39` head, not merged main.

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

## Unfinished acceptance gates

| Gate | Remaining work |
| --- | --- |
| Actual host lifecycle | Default-profile compatibility; cross-host concurrency, cancellation, restart, shutdown and real subagent identity matrix. Both isolated synthetic and one authorized real-model DeepSeek CLI/Agent paths are covered, not the full gate. |
| Independent providers | Runtime-validated capability declarations, a genuinely independent non-fixture provider, fail-before-egress conformance and binding propagation. See [design](PROVIDER-CONFORMANCE.md). |
| Useful comparison | Versioned labeled datasets, usable eval/replay/compare reports, separately bound champion/challenger deployments; no automatic truth labels. |
| Safe operations | Retention preserving idempotency tombstones, independently authenticated recovery evidence, lease/cancellation budgets, migration and privacy/load testing. |
| Easy onboarding | DeepSeek read-only first-run diagnostics are implemented; other hosts/platforms and real user-profile first-run acceptance remain open. No silent credential/settings changes. |
| Release confidence | No known unresolved blocker within declared support scope; tested exact heads, independent review and honest exclusions. Never claim absence of all possible bugs. |

Next increments should close the host lifecycle gaps before broadening the
provider surface. No dashboard, new agent framework, automatic writes, or
automatic threshold loosening is part of this plan. Missing real-host credentials
or a new external authority requirement should be stated precisely; it does not
justify fabricated evidence or abandoning independently verifiable work.
