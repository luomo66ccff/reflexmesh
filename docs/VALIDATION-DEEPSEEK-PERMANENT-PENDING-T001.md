# Installed DeepSeek permanent-pending observer validation t001

Date: 2026-09-25. Scope: the installed DeepSeek Harness `0.1.2-rc.1`
CLI/Loader/Agent/ToolRuntime on Windows, with a disposable profile, synthetic
model adapter, one in-memory tool, abstaining ReflexMesh provider and an
explicit zero-millisecond fenced drain deadline. This is local installed-host
evidence, not a default-profile or real-model test.

## Reproduce

After `npm run build`, use a trusted installed package root (the command loads
that host's code):

```powershell
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-pending-before --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-pending-after --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

The `before` fixture leaves `TaskAwareBoundary.before` permanently unresolved
and starts official Loader unload from independent fixture control, before the
native tool body can run. The `after` fixture first admits one decision, then
leaves its result-journal continuation permanently unresolved while the native
tool result is delivered. Neither pending Promise is released later in the
child process. Both probes require Loader disposal, a revoked SQLite fence,
closed kernel, one native result, an Agent-visible fixed marker and natural
Headless exit; a timeout or exit code alone cannot pass.

## Observed local result

- Root independently ran both installed-host wrapper modes: `before` passed
  **8/8** fixed assertions and `after` passed **8/8**. The pinned installed
  package reported DeepSeek Harness `0.1.2-rc.1`.
- `before` recorded `detachedBefore=1`, no decision row, no attention row and
  no false missing-result count. The native tool ran once after observer
  unload, its result reached the Agent once, and Headless exited naturally.
- `after` recorded `detachedAfter=1`; the previously admitted shadow decision
  remained, but its observer outcome stayed `missing`. Exactly one
  `shadow_outcome_missing` attention reason remained and zero labels were
  created. The Agent received the native result without a retry and exited
  naturally.
- The existing installed-host `observer-fence` and `observer-teardown` modes
  still passed **10/10** and **9/9** respectively. The former separately
  checks that a deliberately late continuation is rejected after fence
  revocation; a permanently unresolved Promise cannot prove that by itself.
- Receipt-contract tests reject a wrong scenario, changed evidence level,
  unsupported host version, missing/extra/failed assertions, nonzero child
  exit and timeout. The focused probe suite passed **12/12**. After
  `npm ci --ignore-scripts` (zero reported vulnerabilities), `npm run check`
  passed **909 tests: 907 passed, zero failed, two local Windows symlink
  privilege skips**; `npm run demo` passed.

## Evidence boundary

This verifies a narrow, opt-in Loader-owned storage-fence behavior with
permanently pending **asynchronous** `before` and `after` continuations. It
does not cancel the native tool or the Promise, impose a wall-clock deadline
on event-loop-blocking code, or prove safety for arbitrary caller-owned
storage. It does not exercise a permanently missing native host result,
default user profile, real model, account credentials, production ledger or
cross-host cancellation. A `missing` observer outcome does not mean the tool
failed or did not run and never authorizes replay. The result remains pinned
to this installed host revision and synthetic fixture; no raw user data or
secret was used.
