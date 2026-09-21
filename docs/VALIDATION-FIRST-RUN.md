# First-run doctor validation

Date: 2026-09-21. Windows, Node.js 24.19.0, npm 11.17.0. This report covers
`feat/first-run-doctor`, based on `a3dfe39b86b0b4a7480486b4c76e6e60e15eb3b7`.
It does not certify a live user profile or the complete host lifecycle matrix.

## Root verification

- `npm ci --ignore-scripts --no-audit --no-fund`: passed in the new worktree.
- `npm run check`: **220 tests, 219 passed, 0 failed, 1 skipped**. The skip is
  the existing unprivileged Windows symlink-input test.
- `npm run demo` and the built durable, recovery and explained task-evidence
  examples: passed. Their evidence remains explicitly synthetic.
- `node adapters/doctor-cli.mjs --help`: exit 0, fixed read-only usage.
- No-argument JSON invocation: exit 1 with four missing explicit configuration
  diagnostics; no account discovery or exception stack.
- Explicit installed DeepSeek **0.1.2-rc.1** package plus a nonexistent private
  ledger path: `prerequisites_ready`, `database_not_created`, escaped file-URL
  Loader insertion, capture off, abstain, shadow, `live_host_unverified`.
  A separate filesystem check confirmed the database had not been created.
- Installed native CLI/Agent synthetic probe rerun after shared package/config
  extraction: **12/12 assertions passed**, including Loader binding, native tool
  result, actual Agent identity, observer drain and natural exit. This probe
  still uses a synthetic model adapter, not remote inference.
- `git diff --check`: passed for implementation changes.

## Added offline regression coverage

The 12 doctor tests cover an unbuilt isolated copy of the CLI; missing and
invalid arguments; unsupported runtime/build; manifests without importing host
entrypoints; control characters and version sanitization; Chinese/space paths;
JSON-safe YAML insertion; no creation of a missing database or parent;
read-only schema-1/2 inspection without migration; corrupt/directory paths;
fixed sanitized open/close failures; and skipped database inspection when Node
or build prerequisites are absent.

Historical projections distinguish model-reported and harness-reported
outcomes, retain conflict/UNKNOWN warnings and explicitly deny execution
authorization. They expose neither raw keys, selected summaries nor exception
text. A selected historical record does not verify today's tenant, scope,
profile or plugin loading. An absent record is not an installation failure.

## Review corrections and limits

Root review required actual historical status/provenance in human output,
the shared 1024-character database-path limit, and accurate Node/build failure
guidance. Negative tests were then added for malformed options and fixed-error
output. The final local suite above includes those changes.

Doctor checks file presence and pinned manifest versions, not artifact freshness,
installation integrity, future filesystem write permission or arbitrary plugin
compatibility. Read-only SQLite access may interact with WAL/SHM sidecars;
bounded output is not constant query time for arbitrary large ledgers. No
credentials, profile editing, model invocation, schema migration, policy replay
or tool execution occurs in doctor.

Remote CI is separate evidence and must match the submitted head. The separate
[authorized real-model result](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md) exercised
the preceding exact baseline, not this doctor's CLI or a user default profile.
