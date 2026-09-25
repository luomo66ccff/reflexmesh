# Historical policy impact preview — local validation t001

Date: 2026-09-25. Platform: Windows, Node 24.19.0, SQLite 3.53.3.
Scope: local read-only evidence CLI and synthetic fixtures only. No real model,
host tool, user profile, private ledger or paid request was used.

## What was checked

- `npm ci --ignore-scripts`: passed; no dependency audit findings.
- `node --test test/evidence-impact.test.mjs`: 7/7 passed. Eight same-binding
  synthetic rows contained six usable predictions, one incomplete row and one
  UNKNOWN row. Changing one threshold from 0.90 to 0.95 produced exactly two
  `allow -> escalate` transitions, `replayed/matched = 6/8`, and did not change
  the 0.95 boundary row. Other tests covered partial pages, candidate mismatch,
  corrupt verdict failure, tenant/source/mode/binding/pack isolation,
  same-effect directive changes, oversized unclassified evidence and a
  completed decision without a prediction.
- `node --test test/first-run.test.mjs test/evidence-impact.test.mjs`: 13 passed,
  one environment-specific npm forwarding test skipped when run directly. The
  retained first-run guide includes a copyable `impact` step and exercises it
  against its synthetic ledger.
- `npm run check`: 983 tests, 981 passed, 0 failed, 2 Windows symlink-privilege
  skips; TypeScript typecheck and build passed. The focused tests were rerun
  after the final no-prediction handling change; the last subsequent code edit
  was indentation-only.
- `npm run demo`: passed. `npm run first-run`: passed the local WAL write gate,
  generated the synthetic summary and removed its temporary ledger/cache.
- `git diff --check`: passed for the working-tree edits.

The CLI receipt contains hypothetical transitions and bounded key/verdict
details, not raw predictions, pack instructions, task summaries, tool arguments,
observations, labels or audit bodies. The tested deliberately private markers
did not appear in output. It does not call a provider or tool, write a ledger,
authorize execution or grant retry permission.

## Limits

One scan is a key-ordered SQLite snapshot, capped at 10,000 keys and 32 MiB of
run bodies. Pages obtained in separate invocations are not one atomic history.
Unreadable evidence is unclassified rather than silently out of scope; damaged
matching completed predictions fail. Matching requires the anchor's tenant,
source, mode, full source-pack digest and canonical deployment binding. This
does not authenticate a ledger controlled by a capable writer, assess model
quality, infer host execution, or prove the broader product bug-free.

Remote PR/main CI and live default-profile host acceptance are outside this
local validation and require separate readback.
