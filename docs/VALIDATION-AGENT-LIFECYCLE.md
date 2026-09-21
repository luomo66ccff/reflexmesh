# DeepSeek CLI / Agent-loop validation

Date: 2026-09-21. This report advances one host lifecycle increment, not the
whole project's [acceptance gates](ITERATION-STATE.md). The earlier native
tool-pipeline [report](VALIDATION-HOST-EXPERIENCE.md) remains a dated snapshot.

## Verified environment

- Windows, Node.js 24.19.0, npm 11.17.0.
- Installed DeepSeek `dsh`, `dsh-llm`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`,
  `dsh-session`, `dsh-session-projection`, `dsh-system-prompt`,
  `dsh-agent-default-model`, `dsh-headless`: **0.1.2-rc.1**.
- `@deepseek-ai/cordis`: **4.0.2**; `cordis-plugin-loader`: **1.0.3**;
  `cordis-plugin-timer`: **1.1.4**.
- Installation source was inspected read-only. User profiles, credentials and
  conversations were not loaded or changed. Temporary probe files were removed
  only after closing their SQLite handle and validating the cleanup target.

## Actual installed CLI result

Root verification at **2026-09-21T13:55:37.677Z** ran:

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode agent-cli --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

All **12/12 assertions passed**. The actual installed CLI loaded an isolated
empty-bundle profile and its explicitly enumerated plugins. The actual Agent
loop requested the fixed in-memory fixture tool, received its matching result,
then emitted the expected completion marker through a synthetic model adapter.

| Assertions | Evidence checked |
| --- | --- |
| Isolated profile and observer loading | Temporary cwd/home and empty-bundle manifest, actual Loader profile tree, observer entry URL and active fiber state |
| Native Agent and model transport | Two synthetic adapter requests and one native ToolRuntime body call; ReflexMesh binding remains `abstain` / `not-configured` |
| Host identity and selected task | Model/tool session agrees with real Agent identity; fresh host-declared, summary-only receipt and expected scope digest |
| Tool dispatch, result and completion | Only the fixture tool is advertised; exact arguments; returned result matches its tool-call ID; stdout equals the fixed marker |
| Observer cleanup | Exit-time getters confirm awaited observer drain and successful kernel close, with Node `beforeExit` observed and one harness-reported outcome |
| Labels | Zero labels; host success is not converted into training or calibration truth |

The report explicitly states `evidenceLevel: cli_agent_loop`,
`agentLoopExercised: true`, `agentE2E: false`, `modelInference: false`,
`modelTransport: synthetic_adapter`, and `classification: abstain`.
Elapsed time is a diagnostic, not a performance benchmark.

## Regression and review boundaries

- New Loader tests cover rejected configuration before storage creation,
  ignored ambient provider/key settings, no fetch, accepted-result drain before
  kernel closure, and hook cleanup after failed readiness registration.
- Task-source tests cover exact Agent/turn/signal isolation, TTL, stale turn-end,
  invalid/sensitive/oversized/replaced claims, malformed plugin provenance,
  bounded capacity, disposal and no message-body access when capture is off.
- Package/probe tests cover missing installation, unsupported version before
  import and the isolated fixed plugin list. Wrapper tests reject incompatible
  evidence claims, incomplete assertions and exit/status mismatch, and strip
  arbitrary child fields. These are offline fixtures, not installed-host tests.
- Review caught insufficient cleanup proof: the host's shutdown deadline can
  force `process.exit` with the original code, including 0. A ledger outcome plus
  exit 0 was therefore not accepted. Current success requires the independent
  product cleanup getters and natural `beforeExit` observation.
- A historical approximately five-second run has no established root cause and
  is not counted as cleanup evidence or a demonstrated host deadlock fix.
- Initial Node 22 CI on Ubuntu and Windows caught an overly strict test-only
  stderr assertion: importing built-in SQLite emits an experimental warning on
  Node 22. The test now permits only that exact warning (or empty stderr), while
  retaining the nonzero failure exit, fixed diagnostic and no-path-leak checks.
  Runtime warnings are not disabled and arbitrary stderr remains a failure.

## Checks

- `npm ci --ignore-scripts --no-audit --no-fund`: passed in the new worktree.
- `npm run check`: **208 tests, 207 passed, 0 failed, 1 skipped** on local
  Windows/Node 24. The skip is the existing unprivileged symlink-input test.
- `npm run demo`: passed; all results remain explicitly synthetic.
- Installed CLI/Agent probe: **12/12**, as detailed above.
- `git diff --check`: passed for the implementation.

Remote CI must match the submitted exact head before being used as evidence.
Its offline fixture tests do not install or exercise DeepSeek packages. The
installed CLI result above is local Windows evidence only.

## Still untested / not claimed

- Real DeepSeek or Jev model inference, real-model end-to-end behavior,
  prediction quality or an independent second ReflexMesh provider.
- Native filesystem or network tool behavior and host permission enforcement;
  the fixture tool reads only a constant in memory.
- Arbitrary user/default profiles, other package versions, installed CLI tests
  on Linux, and all plugins' independent shutdown correctness.
- Complete parallel-tool, cancellation, restart, subagent and concurrent
  root/service teardown coverage across hosts. Quiescing dispatch remains the
  host's responsibility. Process time/output bounds are not a guarantee that
  every spawned descendant stopped after an outer timeout.
- Producer-declared user sources as authentication, claimed summaries as the
  entire final model prompt, comprehensive secret detection or timed physical
  erasure. See the [integration guide](DEEPSEEK-AGENT.md).
- Automatic labels, retries after unknown results, new execution permission,
  production security certification or a universal absence-of-bugs guarantee.
