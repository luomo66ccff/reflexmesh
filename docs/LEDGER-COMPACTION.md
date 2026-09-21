# Reclaim free pages without deleting ledger records

This explicit local maintenance workflow compacts a ReflexMesh ledger using
SQLite VACUUM while retaining every supported table's logical contents. It is
**not TTL retention, historical evidence deletion or a production restore tool**.
If the ledger contains no reclaimable free pages or fragmentation, it may not
shrink. Optional [audit archival](AUDIT-ARCHIVAL.md) is a separate, explicit
row-deletion workflow; create a new backup/plan after it before compaction.

## Try it without an account

```bash
npm ci --ignore-scripts
npm run demo:compaction
```

The demo creates its own synthetic ledger, allocates and drops a dedicated dummy
padding table to prepare free pages, then backs up, previews and compacts the
ledger. It compares all seven tables independently, observes main-file length
after close, and exercises replay, UNKNOWN, labels/reviews and pair-only guards.
It never deletes ledger rows to prepare the lesson. No real user ledger, model,
host application or external tool is used.

To retain editable artifacts, use a new explicit directory whose parent exists:

```powershell
npm run build
node examples/ledger-compaction.mjs --out-dir 'C:\ReflexMeshData\compaction-lesson-t001'
```

The default demo closes all handles before removing only its owned temporary
fixture. Explicit output is never reused or automatically removed.

## Backup, preview, explicitly apply

Stop all workers using the selected ledger. Keep the source, backup and operation
directory in trusted private local directories. Do not run this on a network
share, shared hostile directory or an archive's own `ledger.sqlite`.

```powershell
npm run build
node adapters/runtime-cli.mjs
node adapters/backup-cli.mjs create --db 'C:\ReflexMeshData\shadow.sqlite' --out-dir 'C:\ReflexMeshBackups\before-compaction-t001' --json
node adapters/compaction-cli.mjs preview --db 'C:\ReflexMeshData\shadow.sqlite' --backup-dir 'C:\ReflexMeshBackups\before-compaction-t001' --out-dir 'C:\ReflexMeshData\compaction-plan-t001' --json
# Inspect the plan and stop/quiesce all old workers before this explicit rewrite:
node adapters/compaction-cli.mjs apply --db 'C:\ReflexMeshData\shadow.sqlite' --backup-dir 'C:\ReflexMeshBackups\before-compaction-t001' --plan-dir 'C:\ReflexMeshData\compaction-plan-t001' --apply --quiescent --json
node adapters/compaction-cli.mjs inspect --plan-dir 'C:\ReflexMeshData\compaction-plan-t001' --json
```

All paths are explicit absolute paths. For Windows paths with spaces use quoted
Node entrypoints, not npm argument forwarding. Help works before the build.
The backup and plan output directories must be new; an existing empty directory
is not reused. A plan cannot be placed inside its archive or at a source sidecar
path. File links/known hardlinks and non-regular sidecars are rejected. Canonical
paths and file identity are checked, but hostile replace-and-restore races and
mapped network drives are not certified.

Preview opens the source read-only and writes only its new plan directory.
Read-only SQLite access can maintain WAL/SHM metadata; it does not promise
filesystem immutability. The complete verified archive must match the source's
logical contents, not merely its table counts. A stale but valid archive is
rejected if logical rows differ. Backup origin/authenticity is not attested.

The plan binds the canonical source-path digest and exact file device/inode,
the archive SHA256/length, schema, journal mode, page metadata and full logical
content digest. It contains no raw row bodies or source-path string, but hashes
and counts can still reveal information. Local file modes are requested, not
proof of restrictive Windows ACLs. Protect all artifacts yourself.

`--quiescent` is a local operator declaration, not proof of who authorized the
operation or that remote effects stopped. Apply also independently acquires an
exclusive SQLite maintenance lock; contention fails rather than terminating
other workers or silently retrying. This entrypoint is not exposed through MCP.

## What is preserved and verified

Known schema 1/2/3/4 is checked without migration. Full contents of every supported
table are streamed into a versioned, typed hash, sorted by explicit primary keys;
all explicit columns are included and integer values retain exact BigInt
precision. TEXT uses raw stored bytes with typed length framing and database
encoding, so malformed UTF-8 cannot collapse through replacement-character
decoding. Implicit rowid and page layout are excluded: SQLite may change rowids
in tables without an INTEGER PRIMARY KEY during VACUUM. Structural, integrity
and foreign-key checks supplement the digest; retained JSON is not semantically
certified by hashing it.

Apply uses one connection with EXCLUSIVE locking set before first database
access. Source/plan and source/backup comparisons happen under the maintenance
lock. The connection commits that initial transaction before VACUUM, while
retaining its exclusive lock through post-checks and close. Journal mode,
page size, schema, all logical rows and counts must remain unchanged. No source
checkpoint command, schema migration, row deletion or journal-mode conversion
is requested. Normal SQLite close may checkpoint/clean up WAL metadata.

The separate-process tests exercise another writer specifically after the
initial COMMIT and before VACUUM; this is not just an in-process mock lock.
Official references: [EXCLUSIVE lock lifetime](https://www.sqlite.org/pragma.html#pragma_locking_mode),
[WAL exclusive access](https://www.sqlite.org/wal.html#use_of_wal_without_shared_memory)
and [VACUUM behavior](https://www.sqlite.org/lang_vacuum.html).

`runs`, completed replay metadata, UNKNOWN tombstones, pending/ready/blocked and
pair-only guards, immutable packs, all audit rows, observations, labels and
reviews are retained. No record's age, lease or reviewed status becomes a
deletion/retry permission. Schema 4 also preserves both online archival metadata
tables. Legacy schemas retain v1 seven-table plans/digests; schema 4 uses explicit
v2 nine-table plans with a new digest domain. External archive bodies are not
checked or compacted by this operation.

## Completion and uncertain outcomes

```text
new-plan/
  plan.json
  READY               binds plan bytes; INCOMPLETE must be absent
  attempt/            created exclusively before dispatch; never reused
    STARTED           binds the one attempted dispatch to the plan
    UNCONFIRMED       remains until completion is verified and published
    result.json       before/after report, when available
    COMPLETE          binds result bytes; UNCONFIRMED must be absent
```

Only a successful child result, post-checks, confirmed process close and final
publication produce `verified_compaction`. Removing UNCONFIRMED is the last
publication step. A killed worker, timeout, close failure, lost response or
publication failure after dispatch is conservatively `apply_unknown`: VACUUM
may already have completed. There is no automatic rerun or rollback claim.
Keep the attempt, inspect its receipt, and independently inspect the current
ledger before deciding what to do. Never erase the attempt or restore an older
backup merely because stdout was lost.

`inspect` reads operation artifacts, not the current ledger. A complete receipt
means `recorded_completion` with `currentLedgerVerified:false`; missing/partial
completion means `apply_unknown`, not proof of failure. Hashes are consistency
checks, not authenticated audit. At-most-one dispatch applies to this directory,
not copies of it or an adversary who can rewrite files. No external exactly-once
guarantee is introduced.

`--timeout-ms` defaults to 30000, accepts 100–300000 and applies separately to
each archive-verification/compaction child. Parent filesystem metadata/publication
is outside that deadline. Cancellation kills only the owned child and waits for
close; unconfirmed termination is distinct and is never reported as rolled back.
An abrupt parent loss causes IPC-disconnect shutdown, but a synchronous SQLite
operation can delay processing disconnect; quiescence must not be inferred from
parent exit. The retained attempt still blocks automatic reuse.

## Space and privacy limits

VACUUM can require roughly twice the original database size in extra free space.
There is no disk-reservation/quota guarantee or power-loss certification here.
Insufficient storage and post-check failures must retain their uncertain result
boundary; never delete backups or sidecars to make an operation proceed.

The report's before/after page bytes are logical SQLite sizes while under lock,
not filesystem block allocation. `physicalBytesFreed:null` is intentional. The
synthetic demo separately samples main-file length after close; this observation
is not atomic with a live database and does not prove physical disk reclamation.

Compaction is not secure erasure. Full unencrypted backups, WAL/filesystem
history and other copies can retain data; identifiers and hashes remain online.
No automatic backup deletion, evidence pruning or privacy-compliance guarantee
is provided. Production restoration still requires reconciliation of newer
admission/pairing guards and independently verified external effects.

Actual historical audit retention is provided separately by [audit archival](AUDIT-ARCHIVAL.md),
with explicit coverage and lookup. Compaction never performs its row deletion.
