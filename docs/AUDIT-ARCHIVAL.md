# Smaller online audit history, with explicit verified lookup

This opt-in local workflow removes selected historical **audit rows only** from
an online ledger, retaining a reference to the full verified backup containing
them. It is not automatic TTL cleanup, guard expiry, backup deletion or restore.
Run tombstones, completed results, UNKNOWN, packs, labels, observations, reviews
and every Claude pairing guard stay online. No provider or host tool runs.

## First try synthetic data

```bash
npm ci --ignore-scripts
npm run demo:archival
```

The lesson creates its own ledger and two full archives, with an append between
archival batches. It reads the original run's audit details back byte-for-byte,
checks replay/UNKNOWN/pairing behavior, then verifies schema-4 backup and
nine-table compaction. It never accesses a real user ledger. To keep the owned
fixtures, use `node examples/audit-archival.mjs --out-dir NEW_ABSOLUTE_DIRECTORY`.
The parent must already exist; explicit output is never reused or removed.

## Plan before deleting anything

Build once. Stop **all** old and new workers using the ledger, including open
read-only inspector connections. An idle WAL reader can still prevent exclusive
maintenance; no lock downgrade or forced termination is performed. Choose trusted
private local paths; network/hostile shared filesystems are not certified.
The following paths and cutoff are illustrative, not recommended retention:

```powershell
npm run build
node adapters/runtime-cli.mjs
$cutoffMs = [DateTimeOffset]::Parse('2026-01-01T00:00:00Z').ToUnixTimeMilliseconds()
node adapters/backup-cli.mjs create --db 'C:\ReflexMeshData\shadow.sqlite' --out-dir 'C:\ReflexMeshBackups\audit-t001' --json
node adapters/audit-archive-cli.mjs preview --db 'C:\ReflexMeshData\shadow.sqlite' --backup-dir 'C:\ReflexMeshBackups\audit-t001' --out-dir 'C:\ReflexMeshData\audit-plan-t001' --cutoff-ms $cutoffMs --json
# Inspect plan.json, its cutoff, row count, backup binding and the selected source.
# The next command explicitly deletes the planned online audit rows:
node adapters/audit-archive-cli.mjs apply --db 'C:\ReflexMeshData\shadow.sqlite' --backup-dir 'C:\ReflexMeshBackups\audit-t001' --plan-dir 'C:\ReflexMeshData\audit-plan-t001' --apply --quiescent --json
node adapters/audit-archive-cli.mjs inspect --plan-dir 'C:\ReflexMeshData\audit-plan-t001' --json
```

Preview writes only a new plan directory. It requires a complete verified backup
whose entire logical content equals the source. Cutoff uses the recorded audit
`at` time (not run age, completion state or lease expiry). The exact predicate
is `at < cutoffAt AND seq < capturedMaxSeq`. The maximum sequence's complete
row is retained as an anchor. Empty selections and selections exceeding
`--max-rows` (default/hard maximum 10000) are rejected, not silently truncated.
Use a narrower cutoff if appropriate; do not infer selection from sample counts.

The plan binds full logical content, schema, source path/device/inode, archive
SHA256/length, cutoff/highwater, selected rows and per-run coverage. Hashes do
not authenticate origin. Paths must be explicit absolute local paths; source
and archive cannot be the same file. Archive/plan output must be new, with an
existing parent. File links, known hardlinks and overlapping sidecars are
rejected; malicious same-user replace-and-restore races are not excluded.

## Schema and atomicity

Ordinary fresh ledgers and ordinary migration from schemas 1/2 still produce
schema 3. Only explicit archival apply upgrades 3 to **4**, creating
`audit_archive_batches` and `audit_archive_coverage` in the same transaction
as its batch metadata and row deletion. New ordinary opens preserve schema 4.
Archive apply supports 3/4, not an implicit migration of historical schemas 1/2.
This archival increment accepts only UTF-8 database encoding, positive audit
sequence IDs, and valid UTF-8 run keys within the kernel's 1024-character limit.
Other encodings/non-queryable keys fail before preview publication or deletion;
legacy backup/compaction format support is not silently changed. Audit kind and
details may still contain malformed UTF-8 and are fingerprinted as raw bytes.
Old binaries must stop before upgrade: checking `user_version` on new opens
cannot revoke an old process's already-open connection. This version refreshes
schema on its read/write transactions as a defensive compatibility measure.
It does not make product archival compatible with an open reader: actual apply
still requires every other ledger connection closed. Version-refresh tests
using a synthetic ordinary WAL writer are separate from the exclusive apply path.

One EXCLUSIVE maintenance connection/transaction verifies the source, plan and
backup; inserts the batch and per-run coverage; deletes the exact selection;
then verifies the retained six tables, unselected audit, highwater row and old
archival metadata before commit. A chain of batch IDs is retained online; no
archive paths are stored or automatically opened from the ledger.

All audit appends now reject INT64 sequence exhaustion instead of allowing
SQLite's random ROWID fallback at its maximum. Keeping the highest row prevents
ordinary MAX+1 allocation from reusing deleted historical sequences. This is
not a defense against manual database edits or unsupported older binaries.
See [SQLite ROWID allocation](https://www.sqlite.org/autoinc.html) and
[transaction semantics](https://www.sqlite.org/lang_transaction.html).

## Look up exactly one batch

```powershell
node adapters/audit-archive-cli.mjs history --db 'C:\ReflexMeshData\shadow.sqlite' --key 'RUN_KEY' --json
node adapters/audit-archive-cli.mjs query --db 'C:\ReflexMeshData\shadow.sqlite' --key 'RUN_KEY' --batch 'BATCH_ID_FROM_HISTORY' --archive-dir 'C:\ReflexMeshBackups\audit-t001' --json
# Explicit local evidence disclosure, if required:
node adapters/audit-archive-cli.mjs query --db 'C:\ReflexMeshData\shadow.sqlite' --key 'RUN_KEY' --batch 'BATCH_ID_FROM_HISTORY' --archive-dir 'C:\ReflexMeshBackups\audit-t001' --include-details --json
```

History exposes online counts/ranges and per-batch archive references. Paging
uses `--after BATCH_ID` in lexical batch-ID order, not recency; min/max are
boundaries, not a promise of contiguous
sequences. Query verifies the supplied full archive against the batch and
checks the entire selected run's raw-row count/range/digest before returning a
bounded page. Use `--after-seq DECIMAL` and `--limit` (default 20, maximum 50).
Sequences and audit timestamps are decimal strings; no unsafe-number rounding.
Only the chosen batch is verified: `scope:"one-batch"` never means complete
history across all archives. Missing/wrong run, batch or archive is unverified,
not a successful empty history. No directory scanning or network retrieval.

Default query returns metadata and details digests, not raw details. Explicit
`--include-details` returns base64 stored bytes, preserving malformed UTF-8.
An individual detail is capped at 8192 bytes and all page detail bytes at 32768;
oversized bodies are explicitly omitted with their digest, not presented as
complete. Actual JSON byte length is also capped: details may be omitted or
pages shortened with a continuation cursor to fit the worker receipt budget.
Output still may reveal identifiers/times/kinds; protect it locally.
The archive itself is an entire **unencrypted** database, not a redacted export.

Evidence inspect/list/attention and kernel inspect distinguish partially archived
audit from online history. They do not check external archive availability and
do not turn a missing online audit row into evidence of non-execution. Recovery
reviews and every execution guard remain unchanged; lookup grants no retry.

Explicit coverage/evidence reads and maintenance validate the full online
metadata chain, coverage references, counts, version order and highwater bounds.
Their work can grow with the chain; bounded output is not a bounded-work claim.
Ordinary writes do not certify or repair that chain, and storage diagnostics
keep their bounded per-table scan instead of silently performing a full audit.
Neither path interprets archival metadata as execution authorization.

## Backups, space and lost receipts

Schema 1–3 retain their original v1 seven-table manifest/summary/compaction-plan
format and logical-hash algorithm. Schema 4 uses v2 artifacts and nine-table
content hashing. A new full schema-4 backup includes online coverage metadata,
**not older external audit bodies**. Its manifest says
`externalAuditArchives:"not_verified"`; keep every referenced archive separately.
Verifying the latest backup does not verify the chain. Never restore an old
snapshot over a live ledger to retrieve history.

Deleting audit rows may leave reusable SQLite pages without reducing the file.
After archival, create a **new** backup and plan if you separately choose
[all-record compaction](LEDGER-COMPACTION.md). Its nine-table proof preserves
coverage too. This does not promise lower total storage: full backups can use
more space. It is not secure erasure, legal retention compliance or authenticity.

Plans use new-only `plan.json`/`READY`; `attempt/` is reserved atomically once.
`UNCONFIRMED` remains until result verification, child close, result publication
and its final removal. Any failure after dispatch is conservatively unknown,
including a commit followed by lost receipt. `inspect` checks the saved receipt,
not the current ledger. A batch found by `history` can show it committed, but
neither observation authorizes retry, restoring, erasing the attempt or a new
apply. Never automatically repeat an unknown operation.

`--quiescent` is an operator declaration, not proof of identity or stopped
external effects; apply also requires the SQLite exclusive lock. Deadline
defaults to 30000 ms (100–300000), separately per archive-verification and work
child. Cancellation kills only its owned worker and waits for close; an
unconfirmed termination is reported separately. Parent metadata/publication is
outside that deadline; synchronous work can delay IPC-disconnect handling.
Power loss, actual disk exhaustion, production recovery, hostile filesystem
races and large-ledger load are not certified. File mode is not Windows ACL proof.

Exit codes: 0 completed/read/help, 1 unverified/unknown, 2 invalid arguments,
130 observed cancellation. Errors omit raw evidence, paths and native messages.
