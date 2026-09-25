# In-process deadline range — local validation t001

Date: 2026-09-25. Scope: [Issue #72](https://github.com/luomo66ccff/reflexmesh/issues/72),
the in-process `ReflexMesh` constructor and `withDeadline` helper. This is
not a change to DeepSeek/Claude/Codex host timeout policy or SQLite leases.

Before the fix, Node 24.19.0 reproduced both symptoms offline: a
`2_147_483_648`-millisecond decision timeout caused a 50-ms synthetic
provider to return `provider_unavailable_or_invalid`; the same action timeout
caused `recovery_required` / `action_state_unknown`. Node emitted
`TimeoutOverflowWarning` and set the actual timer duration to 1 ms. The
[Node timer contract](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)
documents that behavior.

The fix accepts integer milliseconds `1..2_147_483_647` and rejects other
explicit values, including `null`, with a `ContractError` before starting
work. An omitted or `undefined` option still selects the existing default.
It does not clamp, round,
silently disable deadlines, alter the defaults or reinterpret an action's
unknown outcome as safe to retry. `DurableMesh` already constructs a
`ReflexMesh` before durable admission, so it inherits the gate without a
storage migration. Direct callers of `withDeadline` receive the same guard.

Focused tests passed **47/47** and cover invalid values for both constructor options and the
direct helper; the minimum and maximum valid values; normal delayed provider
completion; provider, authorizer and tool timeout classifications; and durable
construction before admission. The maximum is validated, never waited out.

`npm ci --ignore-scripts`, `npm run check` (**969 tests: 967 passed, 0 failed,
two local Windows symlink-privilege skips**) and `npm run demo`,
`npm run demo:durable`, `npm run demo:recovery` passed locally. Remote CI is
a separate publication gate. These tests establish this bounded timer contract, not arbitrary host
cancellation, task completion or the absence of all defects.
