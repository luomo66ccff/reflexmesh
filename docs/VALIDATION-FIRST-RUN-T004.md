# First-run cleanup truthfulness validation t004

Date: 2026-09-24. Scope: review fix for open PR #23's synthetic first-run
lesson. This report records local evidence; exact-head remote CI and merge
remain separate checks.

## Finding and correction

The prior `main()` wrote its success message before `finally` tried to
remove temporary data. `removeTemporaryDirectory()` swallowed failures, so
the process could exit successfully while claiming the lesson and selected
task-summary cache were removed. The code now attempts resource closes and
temporary cleanup independently, fails if any such step cannot be verified,
and emits the completion receipt only afterward. A failed cleanup prints a
fixed local diagnostic rather than a false success claim. Retained lesson
data may remain for inspection if its separate temporary cache cleanup fails;
the command does not call it complete in that case.

## Local validation

- `npm ci --ignore-scripts`: passed; npm reported zero dependency
  vulnerabilities for this install.
- `npm run check`: 817 tests, 815 passed, zero failed, two local Windows
  symlink-privilege skips. The new cleanup-failure regression is included.
- `npm run demo` and `npm run first-run`: passed on Node 24.19.0 / SQLite
  3.53.3. The latter printed the completion receipt only after cleanup.
- Node 22.23.3 focused `test/first-run.test.mjs`: five passed; its
  npm-execpath-only nested-command case skipped when invoked directly.
- Injected cleanup failure covers both default `--summary` and `--explain`,
  plus the separate retained-lesson cache. None emits a completed or removed
  receipt; the test cleans its owned temporary paths afterward.
- An initial focused run found a syntax error introduced by this edit. The
  stray parenthesis was removed and the syntax check and focused/full tests
  were rerun successfully. It is not counted as a passing first attempt.

The check does not prove cleanup across process kill, power failure, hostile
same-user path replacement or every filesystem error. It does not exercise a
real provider, user profile or host tool, and does not establish a bug-free
release. Remote PR CI and merge must be checked at the exact submitted head.
