# DeepSeek Loader fenced drain validation t001

Date: 2026-09-25. Scope: a local candidate for optional, bounded isolation of
Loader-owned SQLite callbacks during observer unload. This is local evidence;
reviewed PR, exact-head CI and post-merge CI require separate readback.

## Change and safety boundary

`shutdownDrainWaitMs` is opt-in and starts only after the result-reception
window closes. The product Loader gives its built-in boundary a narrow facade
over its synchronous `SqliteKernel`. Every admitted storage method checks a
revocation bit on each call. If the drain deadline finds a pending `before` or
`after`, the observer first revokes that facade, then detaches those callbacks
from its own unload wait, and the Loader closes the raw kernel. A late
continuation can no longer access that kernel through the boundary. The
original callback may still run or wait indefinitely; it is **not** reported
as drained. The Loader exposes deadline `storageRevoked` and separate
`detachedBefore` / `detachedAfter` counts. Missing host results remain separate.

No new host result, label, permission, retry or tool cancellation is created.
The feature does not apply to the generic programmatic plugin or arbitrary
caller-owned storage. Without this option, unload still waits for actual
callback drain before close.

## Local checks

- Unit and temporary real-SQLite tests cover all seven facade methods,
  no exposed `close`, pending admission and result callbacks at the deadline,
  repeated disposal and Cordis-shaped concurrent disposal, a nonzero window
  that preserves a normally settling callback, a late rejected write blocked
  after kernel closure, no fabricated outcome or labels, and an already
  committed outcome retained when its callback subsequently hangs. A fake
  storage-revocation callback is rejected before listener registration. The
  pre-observation test confirms the
  host middleware proceeds once; that is not proof the host tool is cancelled.
- `npm ci --ignore-scripts`: passed. `npm run check`: **853 tests, 851 passed,
  zero failed, two local symlink-privilege skips**; typecheck and build passed.
  `npm run demo`: passed.
- Installed DeepSeek Harness **0.1.2-rc.1** isolated synthetic-transport
  regressions passed: observer teardown **9/9**, native tool pipeline **13/13**,
  CLI/Agent **12/12**, lifecycle **17/17**, subagent isolation **12/12**. Those
  host scenarios do not inject a forever-pending Loader callback; the new
  deadline itself was exercised in local Loader/Cordis-shaped tests.
- No account, key, default user profile, real model, production tool or user
  data was used.

## Limits

The timeout is not a hard wall-clock bound: a blocked event loop or a blocking
SQLite call prevents its timer from running. The facade relies on this exact
Loader's synchronous SQLite methods; an arbitrary async kernel already past a
facade entry or a custom callback holding another write handle is not covered.
The detached callback, host tool and any external side effect are not stopped;
a pre-hook released at the deadline may allow the host's own permission
waterfall to continue without ReflexMesh observation. `observerDrained=false`
records this loss of full drain, even when `kernelClosed=true` is safe through
the fence. A missing outcome is not proof of effect-free execution and never
authorizes replay or retry.
