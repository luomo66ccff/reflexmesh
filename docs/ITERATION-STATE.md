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

## Current increment: DeepSeek CLI and Agent-loop integration

Integration continues on `feat/deepseek-agent-lifecycle`, based on the reviewed
host-evidence branch. Do not assume either branch has merged; verify the current
PR base, exact head and checks before any merge.

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
  skip. Real-model inference remains untested, not implied by this result.
- Setup and honest evidence limits: [guide](DEEPSEEK-AGENT.md) and
  [validation](VALIDATION-AGENT-LIFECYCLE.md). Earlier reports remain unchanged.

## Unfinished acceptance gates

| Gate | Remaining work |
| --- | --- |
| Actual host lifecycle | Authorized DeepSeek real-model E2E and default-profile compatibility; cross-host concurrency, cancellation, restart, shutdown and real subagent identity matrix. The isolated synthetic CLI/Agent path is now covered, not the full gate. |
| Independent providers | Runtime-validated capability declarations, a genuinely independent non-fixture provider, fail-before-egress conformance and binding propagation. See [design](PROVIDER-CONFORMANCE.md). |
| Useful comparison | Versioned labeled datasets, usable eval/replay/compare reports, separately bound champion/challenger deployments; no automatic truth labels. |
| Safe operations | Retention preserving idempotency tombstones, independently authenticated recovery evidence, lease/cancellation budgets, migration and privacy/load testing. |
| Easy onboarding | Real first-run validation across supported hosts/platforms, actionable diagnostics, installation guidance without silent credential/settings changes. |
| Release confidence | No known unresolved blocker within declared support scope; tested exact heads, independent review and honest exclusions. Never claim absence of all possible bugs. |

Next increments should close the host lifecycle gaps before broadening the
provider surface. No dashboard, new agent framework, automatic writes, or
automatic threshold loosening is part of this plan. Missing real-host credentials
or a new external authority requirement should be stated precisely; it does not
justify fabricated evidence or abandoning independently verifiable work.
