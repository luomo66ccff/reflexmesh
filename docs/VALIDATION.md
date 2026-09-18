# Validation — v0.2.0-alpha.1

Validation date: 2026-09-18. Base: `c9ef6376f3373d47c81f2e19cb86bf8b3209e901`.

| Check | Result in the development container |
| --- | --- |
| Node | 22.16.0; built-in experimental `node:sqlite` available |
| Compiler | Installed TypeScript 5.8.3, matching the pinned dependency |
| `npm run check` | Typecheck/build and **79 tests passed**, zero failures/skips |
| `npm run demo` | Passed, existing offline synthetic fixture demo |
| `npm run demo:durable` | Passed, SQLite reopen + one provider invocation + policy-only replay |
| Original regressions | All 45 original tests retained and passing |
| Durable kernel | Independent connections, simultaneous OS processes, real SIGKILL before/after action start, fencing, conflicts and unknown tombstones |
| Protocol processes | Actual spawned Node MCP STDIO and Claude hook CLIs with fixture input |
| DeepSeek integration | Callback contract fixtures matched to reviewed official tools source; no installed host run |
| Codex / Claude Code applications | Not installed or run; their protocol-facing subprocesses were tested instead |
| Real Jev inference | Not run; no authorized key supplied |
| Fresh `npm ci` in container | Not run successfully; external registry DNS unavailable |
| GitHub CI for this change | Consult the PR check run; this static report does not predeclare its result |

The 34 new tests include portable authoring, exact action/outcome binding, separate observation/label provenance, replay without execution, provider binding changes, unknown SQLite schema, initialized MCP framing, UTF-8/size limits and shadow permission abstention.

Mock probabilities and outcomes are test fixtures, **not model quality or latency benchmarks**. Passing process-kill tests is evidence for the implemented failure cases, not a proof of arbitrary distributed exactly-once effects. No full external security audit, load/soak test, encrypted-retention test, live-host installation test or provider calibration experiment has been completed.
