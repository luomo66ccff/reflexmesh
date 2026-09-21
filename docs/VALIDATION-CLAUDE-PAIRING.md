# Claude cross-process outcome pairing — 2026-09-22

Scope: `fix/claude-outcome-pairing`, based on PR #9's
`f89955848246508b88a06877bbf9ae208a36c940`. This is a stacked increment, not a
change to or certification of merged main. Dates use Asia/Shanghai; probe
receipts use UTC. [Protocol, upgrade instructions and assumptions](CLAUDE-HOOK-PAIRING.md).

## Reproduced before implementation

The initial four-test Node subprocess fixture produced **three failures and one
positive control pass** against the base implementation:

- A task-aware pre rejected a reused call ID after task replacement, but its
  post still appended the new result to the old task's decision.
- The legacy hook likewise accepted a result after the pre rejected a changed
  task-aware deployment binding.
- A pre-existing ordinary-library decision with no hook receipt accepted an
  orphan hook result.
- A normally admitted old result after a new prompt and Stop cache clear was
  correctly accepted. This behavior must remain, not become collateral damage.

These were real separate Node CLI processes with synthetic stdin, temporary
SQLite databases and an abstaining provider. They were **not** executions of
the Claude application, real tools, or model inference.

## Root verification

| Check | Actual result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed |
| Windows Node 24.19.0 `npm run check` | 288 tests, 287 passed, 0 failed, 1 expected Windows symlink skip |
| Portable Node 22.23.2 typecheck and full suite | Same 288/287/0/1 counts |
| Four offline demos | `demo`, `demo:durable`, `demo:recovery`, `demo:evidence` passed |
| New pairing tests included above | 14 kernel + 15 boundary/CLI cases passed |
| Installed DeepSeek lifecycle matrix | 17/17; synthetic transport; receipt `2026-09-21T16:34:59.603Z` |
| Installed official sequential spawn isolation | 12/12; synthetic transport; receipt `2026-09-21T16:35:34.314Z` |
| Installed native outcome-admission probe | 8/8; no model inference |

Reproduce the focused offline tests after building:

```bash
npm run build
node --test test/claude-hook-kernel.test.mjs test/claude-outcome-pairing.test.mjs
```

Coverage includes schema-1/2 read-only inspection and upgrade to 3, receipt
reopen, duplicate pre poisoning, missing/early post, late completion rejection,
token/descriptor/decision/action/deployment/request mismatch, identical post
deduplication, changed terminal report preservation, two independent pre
processes racing, and killing a process after its pending receipt before a post
in another process. Process tests use explicit IPC gates and bounded timeouts,
not timing sleeps to choose a winner.

Migration tests deliberately create an index-name collision so DDL fails after
new table creation. They assert the entire prior application schema/data and
version remain unchanged and no pairing table survives; removing that fixture
obstacle permits upgrade. This validates transactional DDL rollback, not
physical power-loss or filesystem-corruption recovery.

Boundary tests cover both CLI entrypoints, task replacement/cache clearing,
mixed-entrypoint conflicts, actual cache-open failure after reservation, resolver
failure, a before that commits its decision then throws, and injected completion
plus failure-marker storage errors. Pending/blocked receipts cannot accept a
later result. Configuration failure **before** reservation deliberately remains
outside the guarantee. Retained successes show ambiguity in evidence JSON,
human list/inspect and doctor; no observations become truth labels.

Independent narrow review and root inspection both found a diagnostic defect:
an additional pre overwrote the first blocked reason with `duplicate_pre`.
It was fixed to preserve the first reason, then checked again. The reviewer also
independently injected the post-decision before failure. No remaining P1/P2 was
identified in that review; this is not a full security audit or a bug-free claim.

## Evidence limits

- Actual Claude application integration was not rerun. Separate-process
  fixtures do not certify installed-host cancellation, fork/resume, shutdown,
  plugin ordering or default-profile behavior.
- Two pre processes genuinely race; post-before-duplicate-pre and the reverse
  ordering are exercised in separate CLI processes sequentially, not as a new
  concurrent post/pre race matrix.
- No host-echoed attempt nonce, authenticated ingress, same-user tamper defense,
  or proof of an invocation unobserved before durable reservation is added.
  Invalid envelopes/configuration and unavailable storage may leave no marker.
- Existing rows are not rewritten or retroactively paired. Older code's schema
  whitelist rejects version 3 on fresh open by source inspection; old binaries
  and mixed-version already-open workers were not executed as an upgrade test.
- Migration is local SQLite only. Stop old workers and make a consistent backup;
  in-place downgrade, production load/privacy/retention testing, and physical
  power-loss recovery are not certified.
- No user profile was changed, no real model was called, and no paid-model,
  calibration, performance or independent-provider claim is made.

Remote CI evidence must match the published PR's exact head. These local results
do not themselves establish remote CI or merge readiness of the earlier stack.
