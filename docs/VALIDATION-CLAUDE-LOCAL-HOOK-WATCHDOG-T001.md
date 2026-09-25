# Claude local hook fixture watchdog — validation t001

Date: 2026-09-25. This is a test-only CI follow-up, not a change to production
hook deadlines, host permission handling or SQLite admission.

## Failure and correction

- The first [PR #78 CI run](https://github.com/luomo66ccff/reflexmesh/actions/runs/36153035268)
  passed Ubuntu Node 22, Windows Node 22 and both affected-runtime-negative
  jobs, but Windows Node 24 failed `npm run check` in
  `test/claude-local-hook.test.mjs`. In the duplicate-pre fixture, a spawned
  hook child returned `status: null` after the test's five-second deadline.
  The assertion only showed `null !== 0`; it had not checked the child error
  first. The log did not expose an incorrect permission response or ledger
  result. A slow shared runner is plausible, not established as the cause.
- The fixture keeps the same three scenario assertions and exact duplicate
  delivery/pairing invariants. Its finite child deadline is now 20 seconds,
  matching the earlier [Windows hook-fixture follow-up](VALIDATION-FIRST-RUN-T006.md).
  It checks `child.error` before exit status and uses a fixed event/error-code
  message, so a future timeout is diagnosable without dumping private output.
- The focused three-test file passed in ten consecutive local Node 24.19.0
  runs (30/30 test cases). This does not prove the remote failure's root cause,
  production hook latency or absence of all hangs. The final local
  `npm run check` passed 976 tests: 974 passed, zero failed, two Windows
  symlink-privilege skips; `npm run demo` also passed. Updated PR/main CI
  readback remains separate.
