# Policy-only replay CLI: local validation t001

Date: 2026-09-25. This report covers the local Windows checkout, not a merged
GitHub tree or a real host/provider. The candidate and every prediction below
are synthetic.

## What was checked

The existing `replayPolicy` contract now has a single-key `evidence replay`
entrypoint. It accepts a bounded local `DecisionPack` JSON file and reads only
the selected run's state, evidence binding and recorded result, each stored
body capped at 1 MiB before parsing. It does not load audit, observation or
label rows. The candidate must match the event type and exact questions of a
completed valid prediction. The receipt whitelists verdict effect, rule,
optional directive and candidate digest; `hypothetical: true` and
`executionAllowed: false` are not host permission or retry authority.

The retained `first-run` lesson now writes `candidate-pack.json` alongside its
synthetic ledger and `START-HERE.md`. The candidate retains the questions but
raises the fixture intent-match threshold from 0.90 to 0.99. The guide uses the
actual recorded decision key, so its PowerShell command is copyable.

## Local commands and readback

- `npm ci --ignore-scripts` passed.
- `node --test test/evidence-replay.test.mjs test/first-run.test.mjs` passed
  14/15, with one direct-test skip because `npm_execpath` exists only under npm.
- Final `npm run check` passed 925/927, zero failures, two local Windows
  symlink-privilege skips. It includes the npm-forwarded Unicode/spaced-path
  first-run test and eight focused replay cases.
- `npm run demo` passed with the existing synthetic workflow.
- A new-only retained first-run directory with Chinese and spaces in its path
  passed on Node 24.19.0 / SQLite 3.53.3. The exact `START-HERE.md` replay
  command returned `allow -> escalate`, `hypothetical: true`, and
  `execution allowed: false`. SHA-256 of the SQLite main file matched before
  and after the read-only replay. The separate attention view still showed
  two completed shadow decisions with missing host reports; replay did not
  fill or relabel them.

The focused tests cover a changed directive with unchanged effect, wrong
questions/event type, missing or UNKNOWN runs, absent/malformed provider
predictions, malformed/oversized candidate files, oversized stored bodies,
redaction of unrelated stored prose, old-schema read-only access, and unchanged
main-file bytes after actual CLI processes. The existing full suite covers the
broader admission, outcome, recovery and host boundaries, but does not prove
every possible corruption or concurrency case.

## Exclusions

No real provider call, host tool, personal profile, user ledger or independent
quality label was used. The replay does not recompute a model prediction,
calibrate thresholds, test host permission, prove an outcome or authorize
execution/retry. Read-only SQLite may interact with WAL/SHM sidecars, so a
matched main-file hash is not a byte-for-byte whole-directory immutability
certificate. Candidate files and local ledgers still need filesystem access
controls; rule names and digests are metadata, not anonymization. Large-ledger
load, adversarial filesystem replacement and production data were not tested.

Remote PR-head and post-merge CI are separate gates; this local result does not
claim either has passed.
