# Local recovery reviews

This follow-up to Durable Shadow Protocol adds **operator review**, not automatic retry, rollback, compensation or a replacement for authorization. It is an alpha feature for a private local SQLite database. The original in-memory runtime and the Codex/Claude/DeepSeek shadow boundaries are unchanged.

## Operational meaning

Two facts remain separate:

- **Execution state:** the runtime cannot safely replay this logical action (`unknown`).
- **Operator conclusion:** someone reviewed independent evidence and recorded `unresolved`, `confirmed_succeeded`, `confirmed_failed` or `confirmed_not_executed`.

Even `confirmed_not_executed` does not reset admission. A caller reusing that event ID still gets `recovery_required`. No original prediction/result is rewritten, no old tool output is cached, and no calibration label is generated. This prevents a late or duplicated agent message from turning a human review into permission to run again.

A separate, explicitly authorized business action may be necessary after investigation. There is deliberately no `retry`, `reset`, `force`, tombstone deletion or automatic UNKNOWN-to-success command here.

## Inspect, preview, then apply

Build once (`npm run build`), then use the direct Node CLI. It reads an explicit database path and never loads a provider, `.env`, remote credential or network service.

```bash
node adapters/recovery-cli.mjs list --db /private/state.sqlite
node adapters/recovery-cli.mjs list --db /private/state.sqlite --limit 20 --after LAST_KEY
node adapters/recovery-cli.mjs inspect --db /private/state.sqlite --key RUN_KEY
node adapters/recovery-cli.mjs review --db /private/state.sqlite --file review.json
# After independent investigation and quiescing the old executor:
node adapters/recovery-cli.mjs review --db /private/state.sqlite --file review.json --apply
```

`list` uses bounded keyset pagination (1–100 rows) and includes unknown runs and expired executing runs. It excludes administratively reviewed conclusions by default; `--include-reviewed` shows them. An unresolved review remains in the pending queue. Queue membership is not execution eligibility. `inspect` is a bounded metadata view, not a raw transcript/audit dump.

`list`, `inspect` and preview open SQLite **read-only** and do not create missing databases, perform DDL, migrate versions, change application rows or fetch evidence references. SQLite's WAL reader may still interact with WAL/shared-memory sidecars; this is not a byte-for-byte filesystem immutability claim.

A review file must be a regular UTF-8 JSON file of at most 16 KiB. Links/non-regular files, unexpected fields, malformed digests, non-integer epochs and missing quiescence confirmation are rejected. Replace the placeholder values below with the exact values from inspection and your own independent evidence reference/digest:

```json
{
  "schemaVersion": 1,
  "id": "incident-42-review-1",
  "runKey": "<key from inspect>",
  "expectedEpoch": 2,
  "inputDigest": "<64-character lowercase digest from inspect>",
  "resolution": "confirmed_failed",
  "evidenceDigest": "<64-character lowercase digest of independent evidence>",
  "evidenceRef": "incident:42/external-observation",
  "actorRef": "operator:your-local-identifier",
  "reason": "Inspected the external result and stopped the old worker",
  "quiescent": true
}
```

The tool does **not** verify that the external evidence is true, fetch the reference, authenticate `actorRef`, or prove quiescence. These are explicit local-operator declarations. A lease expiry alone is not proof that a remote action stopped. Stop/quiesce the worker and inspect the external system before applying a conclusion. The CLI is not exposed as an MCP tool, but a same-user agent with shell/database access can still invoke it or modify SQLite directly: use separate OS/service privileges before relying on administrative evidence for real enforcement.

## Atomicity and concurrency

Apply checks the input digest, expected epoch, eligible state and expired lease in a single `BEGIN IMMEDIATE` transaction. It increments the epoch, leaves the execution tombstone `unknown`, adds an immutable review and appends an audit event. An audit failure rolls back all those changes. A stale second reviewer is rejected and must inspect again.

A duplicate review ID with the identical normalized body returns its original receipt without another mutation. A reused ID with changed fields conflicts. A later conclusion requires a new review ID and the current epoch; earlier conclusions remain in the review table. `replayed: true` on a review receipt means receipt deduplication, not action replay. It reports the epoch when that review was applied, which need not be the current epoch.

The model observation, operator review and supervised label are three different record classes. A review digest binds the recorded declaration; it is not a cryptographic proof of who submitted it or what happened externally. Database owners can tamper with records. No remote attestation is claimed.

## Schema 1 / 2 → 3 migration

Schema 2 introduced `recovery_reviews` and a queue index; schema 3 adds durable `claude_hook_pairs`. A writable open upgrades schemas 1 and 2 transactionally while preserving existing runs, journal rows, observations, reviews and labels. Read-only opens inspect schemas 1, 2 and 3 without upgrading them. The version is checked again after acquiring the migration write lock. Future unsupported versions are rejected. Historical runs do not receive invented pairing receipts; see [Claude pairing](CLAUDE-HOOK-PAIRING.md).

Before upgrade, stop all old workers and make a SQLite-consistent backup. Do not copy only the main database file out from under an active WAL writer. Previous schema-1/2 software rejects schema 3 on a fresh open, but that guard does not fence already-open old connections. Mixed old/new workers and in-place downgrades are not supported. Do not reset `PRAGMA user_version` or remove pairing rows to bypass a guard. Restoring an old backup can discard newer tombstones and re-enable duplicates; reconcile outstanding actions before any rollback to old software/data.

No automatic retention, garbage collection, vacuum policy, encryption, lease renewal, distributed coordination, external exactly-once effect, or full operator recovery service is added. Reviews only concern library-managed admissions in this local database; they do not retroactively coordinate arbitrary host-owned actions observed in shadow mode.

## Label contract hardening

`addLabel` now requires an actual **own** predicted question and the matching stored pack/digest. An inherited `constructor`/`toString` property does not qualify. Values must fit the question's target domain:

| Question | Accepted target |
| --- | --- |
| Noul / portable binary | Numeric `0` or `1`, not a probability, string or boolean |
| Choice | A declared choice key |
| Score / portable ordinal | An integer rubric index, not the fractional expected model score |

Only the five declared label fields are accepted, with explicit `human` or `test-oracle` provenance and a source reference. These declared sources still rely on trusted host access; strings do not authenticate a human. Existing historical labels are not rewritten or certified by migration, and conflicting labels under distinct IDs still require adjudication before evaluation. No change in thresholds or automatic model training follows from a review or label.

## Verify without credentials

```bash
npm run demo:recovery
node --test test/recovery.test.mjs test/label-contract.test.mjs
```

The demo uses a temporary database, synthetic clock and synthetic evidence. It records a review, reopens SQLite and demonstrates that the next admission remains `unknown`. No tool or provider is executed. The tests cover real CLI subprocesses, two OS processes racing to review the same epoch, read-only schema-1 inspection, migration, rollback injection, late writers and label-domain rejection. See [validation scope](VALIDATION-RECOVERY.md).

## Primary implementation references

- Node 22.16 `DatabaseSync` and read-only open: https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html
- SQLite transaction and `BEGIN IMMEDIATE` behavior: https://www.sqlite.org/lang_transaction.html
- WAL local-filesystem, checkpoint and backup considerations: https://www.sqlite.org/wal.html

The API floor remains Node 22.16, but that version's SQLite 3.49.1 does not meet
the current persistent WAL write gate. Writable opens, including review apply,
require an actual SQLite runtime containing the known WAL-reset fix before any
file open or migration. Read-only inspection remains available; see
[runtime requirements and manual restart guidance](SQLITE-RUNTIME.md).
This is an engineering extension of the project's evidence-bound decision
contract, not a claim of a novel database algorithm or production safety certification.
