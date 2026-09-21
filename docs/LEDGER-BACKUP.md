# Consistent ledger backups, without restore authority

Create a new archive of an explicitly selected local ReflexMesh ledger, then
verify it offline. No account, provider, host application or external tool runs.
This copies the **entire unencrypted database**, including its retained evidence,
labels, identifiers and admission guards. Only the printed report/manifest is
minimized. Choose a trusted private local directory and protect access yourself.
File modes are requested, not proof of restrictive Windows ACLs.

## Try the account-free lesson

```bash
npm ci --ignore-scripts
npm run demo:backup
```

The lesson makes its own synthetic WAL ledger, backs it up while its writer is
still open, and verifies a separate restored fixture. All seven tables are
compared, then replay/UNKNOWN/pairing guards are tested. It also adds a new
UNKNOWN after the snapshot: the older archive still verifies, but lacks that
guard. This is why a valid archive is not permission to overwrite a current
ledger. No production restore command is provided.

To retain editable/inspectable synthetic artifacts in a new directory (quote
space-containing Windows paths through Node directly):

```powershell
npm run build
node examples/ledger-backup.mjs --out-dir 'C:\ReflexMeshData\backup-lesson-t001'
```

Only the default lesson deletes its own temporary fixtures, after handles and
workers close. An explicit directory is never removed or reused automatically.

## Create and verify

```powershell
npm run build
node adapters/runtime-cli.mjs
node adapters/backup-cli.mjs create --db 'C:\ReflexMeshData\shadow.sqlite' --out-dir 'C:\ReflexMeshBackups\t001' --json
node adapters/backup-cli.mjs verify --dir 'C:\ReflexMeshBackups\t001' --json
```

Both paths must be explicit absolute local paths. The source must exist; the
output parent must exist, but the output directory must **not exist**, even if
empty. No recursive parent creation, overwrite, automatic rerun, or existing
destination reuse. Source/destination file links, known multiple hardlinks,
non-regular sidecars and unsupported UNC/device paths are rejected. Parent
aliases are canonicalized; mapped network drives and hostile same-user path
replacement are not certified. This is a trusted local-filesystem workflow.

The create command requires the [fixed SQLite runtime](SQLITE-RUNTIME.md) before
reserving an output directory. The source is opened with `readOnly:true`, a read
transaction pins its snapshot, and SQLite's Online Backup API captures committed
WAL records. It never migrates source schema or requests source checkpoint,
VACUUM or repair. SQLite's read-only open can still maintain source WAL/SHM
metadata; application-row immutability is not filesystem immutability. A long
read transaction can delay checkpoint reclamation and let the source WAL grow.

The native API can overwrite a target, so only an exclusively reserved empty
file in the new private directory is passed to it. After copying, **only that
owned destination** is normalized to DELETE journal mode, closed and checked
for absent sidecars. Thus the published archive is self-contained, not merely
a copy of the active source main file. It is not promised byte-identical to
that source main file.

Sources: [Node Online Backup API](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html#sqlitebackupsourceDb-destination-options)
and [SQLite backup consistency](https://www.sqlite.org/backup.html).

## Completion, deadlines and uncertain outcomes

The fixed layout is:

```text
new-archive/
  INCOMPLETE       present while work/publication is unfinished
  ledger.sqlite    whole standalone database
  manifest.json    version, full-file hash, byte count, bounded summary/checks
  COMPLETE         binds the manifest bytes by SHA256
```

`COMPLETE` alone is insufficient. All database checks, hashes, child exit and
publication checks must pass; removing `INCOMPLETE` is the final publication
step. Verification requires exactly the three completed files and rejects any
remaining incomplete marker or unexpected file/sidecar. Publication failures
keep incomplete output for inspection, with no overwrite or automatic retry.
No source file is deleted. Neither file existence nor a process exit alone is
a success receipt.

`--timeout-ms` defaults to 30000 and accepts 100 through 300000. SQLite backup,
integrity checks and whole-file hashing run in a dedicated child. Timeout or
Ctrl+C kills that owned child and waits for close; failure to confirm termination
is reported explicitly, never as a completed cancellation. No unrelated worker
is terminated. Metadata/preflight/publication operations are outside that child
deadline; this is not a disk-size quota or an OS sandbox.

If the parent/caller loses the final response **after publication**, the archive
may already be complete. Inspect the directory and run `verify`; do not infer
failure from lost stdout, erase output, or automatically repeat into a new path.
An abrupt parent death may leave an orphan child briefly; IPC disconnect makes
the owned worker exit and it never publishes the COMPLETE marker itself.
This is not a power-loss/directory-fsync durability certification.

## What verify establishes

The verifier accepts only the repository-generated schema-1/2/3/4 structures,
including their known constraints and indexes. Unknown/custom schema variants
fail closed rather than being normalized. It checks SQLite integrity and
foreign keys, a standalone DELETE header/journal and absent sidecars, full-file
SHA256/length, and a strict manifest bound by COMPLETE. Raw header checks precede
SQLite open, so a standalone WAL-header input is rejected without generating
new sidecars. No schema migration, repair or journal conversion happens during
verification.

Schemas 1–3 retain the original v1 manifest and seven-table summary shape.
Schema 4 uses v2 with nine tables, including audit archive batches/coverage.
The backup contains all **online** records, not audit bodies moved into previous
external archives. `externalAuditArchives:"not_verified"` is explicit: a valid
new backup does not prove that those older archives are available. Keep every
referenced archive and use [explicit one-batch lookup](AUDIT-ARCHIVAL.md).

Manifest table/state counts use a **bounded sample of at most 1000 per table**.
Truncated totals are null, unsupported old-schema tables are null, and the sample
is not chronological or representative. The full database hash is independent
of that sample. The verifier checks the complete file, not only sampled rows,
but does not validate every retained JSON body's application semantics.

Before/after hashes and file identity checks detect ordinary concurrent changes.
They do not defeat malicious replace-and-restore races or authenticate the
archive's origin: anyone who can rewrite all files can rewrite their hashes.
On legacy Windows Node builds, a path stat may omit the volume ID (`dev=0`)
while the open-handle stat knows it. Only this cross-path/handle field is treated
as unknown; inode/length/timestamps remain exact big integers and both path and
handle identities must separately stay unchanged. This does not attest volume
identity or exclude identical-metadata cross-volume replacement races.
An archive could already be old, consistently corrupted at the semantic layer,
or missing actions from another ledger. Reports keep
`sourceFreshness:"not_attested"`, `authenticity:"not_attested"`,
`restoreAuthorized:false` and `retryAllowed:false`.

Inspect a verified archive using the read-only [evidence CLI](EVIDENCE.md), not
a writable kernel. To experiment, use the synthetic demo's separate restored
fixture; do not modify the archive itself. Actual production restoration would
also require quiescing **all** old workers, reconciling newer admission/pairing
guards and external effects, and a separate authorized plan. Merely having a
valid older snapshot cannot establish those conditions.

Exit codes: 0 verified archive/help; 1 failed or unverified; 2 invalid arguments;
130 observed cancellation. Fixed error codes do not echo source paths, private
row contents or native exception text. `--help` works before the TypeScript build.
