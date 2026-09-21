# Read-only storage diagnostics

Answer “how large is this ledger, what records are present, and what evidence
must not be casually discarded?” without a cleanup or retry command. This
is an operational retention diagnostic, **not implemented garbage collection
or a claim that space can safely be reclaimed**.

## Start without an account

```bash
npm ci --ignore-scripts
npm run demo:storage
npm run demo:storage -- --out-dir storage-lesson
npm run evidence -- storage --db storage-lesson/synthetic.sqlite
npm run evidence -- storage --db storage-lesson/synthetic.sqlite --scan-limit 1 --json
```

The default demo creates a private temporary synthetic ledger, shows complete
and deliberately truncated samples, then closes all connections and removes
only its own fixture directory. No model or tool runs. Completed shadow,
reviewed UNKNOWN and pair-only records illustrate why finished or reviewed
does not mean safe to delete. The explicit output directory must be new and
preserves an inspectable example; existing directories are never overwritten.

The inspector itself never creates a missing database or deletes fixture/real
data. Build once (`npm run build`) before using the direct Node entrypoint on
a clean checkout. `storage` requires an explicit existing regular database,
resolves its canonical path and opens `readOnly:true`. It does not discover
host profiles, load credentials, invoke providers or apply recovery reviews.

On the tested Windows/npm 11.17.0 shell path, npm argument forwarding lost
quoting for a space-containing output path. For spaces or nontrivial absolute
paths, use the direct entrypoints after building; these forms are process-tested
with spaces and Chinese characters:

```powershell
node examples/storage-diagnostics.mjs --out-dir "C:\private workspace\new storage lesson"
node adapters/evidence-cli.mjs storage --db "C:\private workspace\new storage lesson\synthetic.sqlite" --json
```

The parent directory must exist; use your own private path. Split/extra arguments
are rejected instead of being silently joined into an unintended filesystem path.

## Read the measurements correctly

| Field | Meaning | Not a claim about |
| --- | --- | --- |
| `database.pages.logicalBytes` | `page_size × page_count` in the SQL snapshot | Physically allocated disk bytes or per-table size |
| `database.pages.reusableBytes` | `page_size × freelist_count`, reusable inside SQLite | Bytes this command can release to the filesystem |
| `files.entries.database/wal/shm.logicalBytes` | Independently sampled regular-file length | An atomic SQL/filesystem snapshot or reclaimable bytes |
| `tables.NAME.scanned` | Rows in that table's bounded sample | Always the entire table |
| `tables.NAME.total` | Exact count only when there is no lookahead row | Estimated total when truncated |

SQLite describes freelist pages as available for reuse. Changing file size
requires separate operations, none of which this command performs. See the
[SQLite PRAGMA reference](https://www.sqlite.org/pragma.html#pragma_freelist_count).
WAL and SHM are separate observations, not added to the database page total.
An active writer or another process's checkpoint may change the files between
samples. `files.atomicWithDatabase` is always false; no per-table byte
attribution or physical filesystem-allocation measurement is provided.

File statuses are explicit: `present` includes legitimate zero-byte regular
files; `missing` means ENOENT; `unavailable` means permission, IO or unsafe-size
failure; `not_regular` means a link, directory or other non-regular entry.
All non-present lengths are `null`, never an invented successful zero reading.

### Precise read-only boundary

One SQL read transaction inspects schema 1/2/3 without changing application
rows, epochs, digests or schema. No DELETE, VACUUM, checkpoint, journal-mode
change or `immutable=1` setting is issued. SQLite WAL readers may use/create
shared-memory sidecars: this is **not byte-for-byte filesystem immutability**.
See [SQLite's read-only WAL conditions](https://www.sqlite.org/wal.html#read_only_databases)
and the existing [recovery boundary](RECOVERY.md).

The metadata sampler uses `lstat`, but this does not establish that SQLite
never touched a sidecar link earlier while opening the database. Use a trusted
private local directory, not an adversarial/racing filesystem or network share.
Canonical resolution does not prevent replacement races or hard-link aliases.

## Bounded counts and coverage

`--scan-limit` defaults to 1,000 and accepts integers 1–10,000 **per table**.
Seven fixed tables are considered. Each supported table returns at most the
limit plus one lookahead row. State/pair-only counts exclude the lookahead.
The row bound is not a hard wall-clock/IO deadline for arbitrary databases.

When additional rows exist, `truncated:true`, `scanned` is the sample size and
`total:null`; human output says `TRUNCATED, total unknown`. Do not extrapolate
an estimated total or health conclusion. There is no ordering/recency guarantee
or representative-sampling claim. The limit is not an age/TTL filter.

`runStates.counts` describes only scanned runs. `pairStates.counts` and
`pairStates.pairOnly` describe only scanned pairing rows. Pair-only means no
matching run in the **full runs table in the same SQL snapshot**, not just no
match in sampled runs. A pairing guard with no decision row can be important;
unlike `evidence attention`, this summary includes those reservations.

Schema 1 lacks recovery reviews and pairing; schema 2 lacks pairing. Those
tables return `supported:false` and null counts, not invented zero observations.
Unexpectedly missing required tables or malformed selected metadata fail
instead of appearing empty. This is not an integrity check, complete schema
validator or inventory of unknown user-added tables.

## Retain the distinctions between records

| Table | Retained role |
| --- | --- |
| `runs` | Durable request identity, completed replay metadata, admission/uncertainty guards |
| `claude_hook_pairs` | Pending/ready/blocked association guards, including pair-only records |
| `audit` | Runtime events, not a replacement for action idempotency |
| `observations` | Host/model/test reports, not automatically truth labels |
| `labels` | Independently supplied target declarations, not incident absence |
| `recovery_reviews` | Operator conclusions, not retry permissions or rewritten outcomes |
| `packs` | Immutable versioned contracts referenced by evidence |

No record class is automatically a deletion candidate. Completed runs still
guard replay, reviewed UNKNOWN still blocks execution, and lease expiry does
not prove an external action stopped. Run/pair schemas lack complete creation
timestamps: no retention age is derived from leases, keys or latest audit time.

Reports set `retention.deletionAllowed:false`, `retryAllowed:false`,
`ageEligibility:"not-computed"` and `executionAllowed:false`. There are no
`--apply`, `--delete`, `--vacuum`, `--checkpoint` or retry options.

## Next actions and privacy

Use `evidence attention` for decision rows needing review, `evidence inspect`
for a selected decision, or `recovery list/inspect` for execution uncertainty.
The summary exposes no keys, pairing tokens, digests, raw evidence/results,
audit details, label bodies or review bodies. SQL projection does not select
or parse those bodies. SQLite naturally reads underlying pages, so this is
an output/projection boundary, not page-level data isolation. Counts and sizes
can themselves be sensitive: protect the database and reports with local ACLs.

For actual space pressure, an independently designed, authorized retention/
backup plan must preserve idempotency and pairing guards. Do not copy only a
live WAL database's main file, remove sidecars, reset schema versions or discard
UNKNOWN to make storage appear healthy. Space reclamation, verified backup/
restore, authenticated recovery and full load/privacy acceptance remain open.
