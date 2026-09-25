# Policy what-if consistency guards — local validation t001

Date: 2026-09-25. Scope: local Windows checkout, synthetic SQLite fixtures,
account-free. This report does not certify a real host, provider, user ledger,
or tamper-proof storage.

## Reproduced defect and correction

Before the correction, two new black-box CLI tests failed: `pack-template`
successfully exported a source pack even after the stored original verdict was
changed from `allow` to `deny`, and `replay` successfully compared decisions
after the stored prediction's model was changed away from its recorded binding.
Both paths could present plausible what-if evidence from inconsistent records.

The export now validates the recorded prediction against its bound pack,
recomputes the original policy verdict, and requires canonical equality with
the persisted verdict before creating the new output file. The pure replay
path now requires the prediction model to equal the recorded deployment model
ID. The CLI emits fixed errors without the tampered private marker strings.
Neither check calls a provider or tool or writes to the ledger.

## Local checks

- `npm ci --ignore-scripts`: pass; zero audit findings in this local install.
- Focused `node --test test/evidence-pack-template.test.mjs test/evidence-replay.test.mjs`:
  16 tests, 16 pass, 0 fail after the correction; the two new tests failed
  before it.
- `npm run check`: 935 tests, 933 pass, 0 fail, 2 local Windows symlink
  privilege skips; TypeScript typecheck and build passed.
- `npm run demo`: pass, with synthetic fixtures.
- `git diff --check`: no whitespace errors; Git emitted only Windows CRLF
  conversion warnings.

## Limits and next evidence

Canonical verdict agreement detects accidental or partial corruption; a
capable writer could alter both the ledger and its pack consistently. Direct
replay still reads only the selected run and does not independently reload
its original pack body, including on legacy stripped-schema fixtures. The
source-pack export performs the stronger original-pack check, but it is not
authenticated evidence. All execution and host authorization remain outside
policy replay. The initial PR-head run had one unrelated Windows Node 22
failure: its PowerShell-quoting test returned no exit status after a 5-second
subprocess timeout. The test's cold-start budget was raised to 20 seconds
without changing the production probe. That amended head needs a fresh CI
run; the initial red run is not a passing result. Post-merge main CI must be
checked separately before claiming integration.
