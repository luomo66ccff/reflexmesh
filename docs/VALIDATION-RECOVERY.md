# Recovery-review validation scope

Base: `486760eab31d5d75096f79ac32faf8d080cfc840`. Date: 2026-09-18.

## Local evidence

- Node 22.16.0 and TypeScript 5.8.3.
- **32 new tests** in `recovery.test.mjs` and `label-contract.test.mjs`.
- The local focused workspace ran these tests plus the **45 original core regressions: 77 passed**, zero failures/skips on Linux.
- The existing offline demo and the new `demo:recovery` ran successfully.
- The edited SQLite file and the unchanged DurableMesh used in the focused workspace were checked against their exact Git blob hashes from the base commit before editing/testing.

The local container could not resolve GitHub/npm for a full fresh checkout/install. The focused workspace therefore used the supplied original source archive, fetched current durable files and the installed matching compiler. **It is not represented as a complete rerun of all 79 previous alpha tests.** The other 34 existing alpha integration/durability tests remain in the remote repository and must pass with the new tests in PR CI. Full CI runs a clean install, all test files and all three demos; consult the actual PR check result rather than treating this document as a predeclared pass.

## New failure cases exercised

| Area | Evidence |
| --- | --- |
| Review contract | Unexpected fields, bad digests/epochs, absent quiescence, accessors and bounded provenance rejected |
| Read-only path | Missing DB not created; schema-1 inspection/preview does not migrate or write application records |
| Migration | Schema 1 upgrades to 2 with previous audit/outcome records retained; future schema rejected |
| Concurrency | Independent connections and **separate OS processes** race at the same epoch; only one differing review is accepted |
| Atomicity | Injected audit failure rolls back state, epoch and review insertion |
| Idempotency | Identical receipt deduplicates; same ID/different review conflicts; late executor writes are fenced |
| Execution boundary | Every review conclusion leaves UNKNOWN; a DurableMesh timeout remains non-retryable after review/reopen |
| CLI | Actual Node subprocesses; preview/apply separation; invalid JSON/UTF-8/oversize inputs; non-regular file rejection |
| Labels | Stored question/pack identity, own-property checks and binary/choice/ordinal target domains |

Mock results, synthetic clocks and operator declarations are explicitly test fixtures. This work does not measure classifier quality, real provider latency, actual host compatibility, load/soak resilience or externally authenticated human evidence. No Codex/Claude Code/DeepSeek application, real Jev account or production database was connected in this validation. No external security audit was performed.
