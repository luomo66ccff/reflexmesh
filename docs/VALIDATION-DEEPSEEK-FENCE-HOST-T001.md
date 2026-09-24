# Installed DeepSeek Loader storage-fence validation t001

Date: 2026-09-25. Scope: one account-free installed DeepSeek Harness
0.1.2-rc.1 CLI/Loader/Agent/ToolRuntime scenario using an isolated temporary
profile, a synthetic model adapter and one fixed in-memory tool. This is a
local installed-host receipt, not default-profile, real-model or broad host
shutdown acceptance.

## Reproduce

Use a trusted installed package root: the command executes that host's code.
It creates a temporary home, profile, cwd and ledger, and removes them after
the bounded child exits. It does not inherit the user's DeepSeek profile or
load credentials.

```powershell
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-fence --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

The fixed tool returns once through the native runtime. After its genuine
`tools/result`, the fixture delays only the ReflexMesh `after` journal
continuation at an explicit gate. While that callback is pending, the fixture
uses the official Loader to disable **only** the observer, with opt-in
`shutdownResultWaitMs: 0` and `shutdownDrainWaitMs: 0`. After unload resolves,
the fixture releases the gate, checks that the late storage call is refused by
the Loader's revoked fence, and lets the Agent finish naturally. The second
synthetic model request waits for this check before producing the fixed marker.

## Observed local result

- Installed Harness 0.1.2-rc.1: the wrapper passed **10/10** fixed assertions.
  The probe required an actual native result, a pending `after` at unload,
  `observerDrained=false`, `kernelClosed=true`, `storageRevoked=true`, one
  detached `after`, zero missing host results, and a rejected post-close
  storage attempt.
- The read-only temporary ledger had exactly one shadow run with the bound
  task/Agent/tool evidence, `hostOutcome.status: missing`, zero outcome
  observations, one `shadow_outcome_missing` attention reason and zero labels.
  Here the host **did** return a result; `missing` truthfully means its
  observer-side result write was detached, not that the tool did nothing.
- The Agent received that native tool result once, the tool body ran once,
  and Headless produced the fixed marker and exited naturally. Offline
  regression tests reject changed evidence claims, malformed success
  receipts, mismatched child exit and missing installation.
- `npm ci --ignore-scripts` and `npm run demo` passed. `npm run check`
  passed **857 tests: 855 passed, zero failed, two local symlink-privilege
  skips**, including the four new fence-contract tests. The existing
  installed observer-teardown probe still passed **9/9**.

## Boundaries

This exercises a deliberately delayed continuation of the exact built-in
`TaskAwareBoundary.after` with real installed Loader disposal. The gate is
released after unload, so it is not proof of an indefinitely unresolving
callback, arbitrary caller-owned storage, a blocked event loop or a total
host shutdown bound. The fence does not cancel the callback or native tool.
No permission, retry, fabricated result, label, real-model call, default
profile, transcript or production tool was involved. `missing` is not
permission to replay and is not a ground-truth failure label.
