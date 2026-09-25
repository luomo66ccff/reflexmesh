# Read a decision without confusing it with execution

ReflexMesh binds a decision to its task evidence, action digest, immutable pack,
and provider deployment. The evidence CLI makes that record readable without
calling a provider, running a tool, retrying an action, or altering a database.

For bounded table/state/pair-only counts and database/WAL/SHM file lengths,
use `npm run evidence -- storage --db PATH`. It distinguishes incomplete samples
from totals and never recommends automatic deletion; see the
[storage diagnostics guide](STORAGE-DIAGNOSTICS.md).

## Start without an account

From a clone with Node.js 22.16 or newer:

This is the API floor for read-only inspection. Any command or example that
creates a persistent ledger also needs the
[actual SQLite WAL write gate](SQLITE-RUNTIME.md); Node 22.16.0 does not pass it.

```bash
npm ci --ignore-scripts
npm run first-run
```

The first-run command checks the actual SQLite WAL-write gate, builds the project
and shows four stages: missing task evidence,
a recorded decision with no host result yet, a separately reported result, and a
cleared task. Repeating the same decision reuses its evidence. Clearing the task
does not reuse its old summary. Classification and outcomes are explicitly
**synthetic fixtures**; no model or real host tool runs. Temporary SQLite files
are closed and removed at exit. This is a product walkthrough, not an accuracy
benchmark or a live integration test.

To keep a synthetic ledger for trying the read-only evidence commands, select a
new output directory:

```bash
npm run first-run -- --out-dir evidence-lesson
```

The command refuses any existing target and writes `ledger.sqlite`, a synthetic
`candidate-pack.json` and `START-HERE.md`; the selected task-summary cache is
temporary and removed. The guide includes copyable `list`, `attention`,
`inspect` and policy-only `replay` commands. It never
opens or changes a real ledger. Read-only SQLite access can still create or
interact with WAL/SHM sidecars; it is not a byte-for-byte filesystem
immutability guarantee. On Windows, quote paths with spaces; after the build,
direct invocation is available as
`node examples/task-intent.mjs --summary --out-dir "NEW DIRECTORY"`.

## Inspect your own local shadow deployment

Build once, then pass the existing ledger path explicitly. The inspector does
not load `.env`, host settings, or provider credentials.

```bash
npm run build
npm run evidence -- list --db /private/path/shadow.sqlite
npm run evidence -- inspect --db /private/path/shadow.sqlite --key KEY_FROM_LIST
```

List output includes the full call key, recorded run state, policy effect,
reported outcome and its source, and task coverage. Inspect adds the exact pack
and provider revisions, a short explanation, source counts, label count and
recovery status. An `allow` policy result never means the CLI or observer has
granted host permission. A `confirm` result remains a request for confirmation,
not evidence that confirmation happened.

| What you see | What it establishes |
| --- | --- |
| `run: completed`, `mode: shadow` | The semantic observation settled; it does not establish host execution. |
| `host outcome: missing` | No linked result was recorded; it does not prove that no action happened. |
| `model-reported:succeeded=1` | A model claimed success; this is not a trusted host observation or truth label. |
| `harness-reported:succeeded=1` | The host reported success; this is still separate from independent truth. |
| `host outcome: conflicting` | Recorded sources disagree; the inspector does not select a successful answer. |
| `hook pairing: blocked` | A Claude result's invocation association is ambiguous, even if an earlier success report remains. Independently investigate; do not retry. |
| `hook pairing: pending` | A Claude pre-hook reservation has not completed; this does not establish whether the host ran its tool. |
| `task: ready`, `summary-only` | A selected summary was usable at decision time, not necessarily now. It is not the full request or authorization. |
| `recovery required: true` | Execution remains uncertain. Investigation must not automatically retry the same logical action. |

An operator conclusion such as `confirmed_not_executed` never converts an
UNKNOWN tombstone into retry permission. Use the separate [recovery
runbook](RECOVERY.md) to investigate and record a review.

## Ask a policy-only what-if question

After reviewing a completed decision with a valid recorded prediction, you can
export its *original* full `DecisionPack` into a new local file. This checks
the pack row against the decision's ID, version, full digest, event type and
question digest, and validates the recorded prediction before writing. It
refuses missing, UNKNOWN, damaged or oversized source records and never
overwrites an existing destination:

```bash
node adapters/evidence-cli.mjs pack-template --db /private/path/shadow.sqlite --key KEY_FROM_LIST --out /private/path/new-candidate-pack.json
```

The export is not a generic dump: it reads only the selected run and its bound
pack, not audit, observation or label bodies. It also recomputes the original
policy verdict from the recorded prediction and refuses an inconsistent stored
verdict. The full pack **may contain sensitive question instructions**. It is
written with a restrictive new-file
mode where supported and is never printed to stdout or JSON; the containing
directory's ACLs still matter, especially on Windows. If writing or readback
fails, the new file may be incomplete; inspect it before continuing. No
provider, tool or ledger write runs. An unchanged exported pack should replay
to the original effect, but the ledger is not authenticated or tamper-proof.

Review the exported JSON privately, then change its `version` and only the
rules or thresholds you intend to test. Keep the recorded event type and exact
question contract. The following command computes only a hypothetical verdict
from the previously recorded answers:

```bash
node adapters/evidence-cli.mjs replay --db /private/path/shadow.sqlite --key KEY_FROM_LIST --candidate-pack /private/path/candidate-pack.json
```

The retained first-run lesson includes a candidate pack, a complete replay
command with its synthetic key, and an optional source-pack export command.
Raising its intent-match threshold from `0.90` to `0.99` changes the already
recorded fixture `allow` to a hypothetical `escalate`. No new provider call,
host tool, permission decision or label is created. A hypothetical `allow` is
**not** permission to execute or retry.
The result is not a comparison of model quality, not a new prediction and not
evidence that an action did or did not happen. Missing, incomplete, UNKNOWN or
contract-mismatched records fail instead of inventing answers.

The replay CLI accepts a bounded regular JSON file, not executable code. It reads only
the selected run's replay fields and, when present, its bound source pack;
it does not read the audit/observation/label bodies, and
prints the original and candidate verdicts without prediction distributions,
task summaries or tool arguments. Use `--json` for a machine-readable receipt;
rule names and pack digests can still be sensitive metadata. This is
a read-only application operation, subject to the SQLite WAL/SHM caveat below.
Replay rejects a prediction whose model differs from the recorded deployment
binding. When the source-pack table exists, it also reads that pack in the same
transaction as the selected run and recomputes the stored original verdict.
The receipt reports `originalSourceConsistency: verified` only after those
local consistency checks. A stripped schema-1 ledger without the pack table
can still replay for compatibility, but reports `legacy_unverified` before
displaying the stored original; that original verdict was not recomputed.
Missing or damaged bound packs in a ledger that has the table fail closed.
Neither command authenticates a locally modified ledger. Keep the database
under trusted local access controls and use the source-pack export when
reviewing a changed policy.

When the original source pack is verified, `replay` also reports `policyChanges`:
counts of added, removed and structurally modified rules, whether the relative
order of rules shared by both packs changed, whether fallback changed, and
`structureUnchanged`. A version-only change therefore reports no policy-body
edit. The summary compares rule conditions, effects and directives without
printing their values or source question instructions. It is not causal
attribution: several edits may contribute to a changed verdict, and a reported
structural edit may not affect this recorded prediction. For a stripped schema-1
ledger the field is `{ "status": "legacy_unverified" }`, not a guessed diff.

## Find evidence that needs attention

```bash
npm run evidence -- attention --db /private/path/shadow.sqlite
node adapters/evidence-cli.mjs attention --db /private/path/shadow.sqlite --limit 20 --json
```

Use this after reconnecting or restarting a host to find recorded decisions
whose evidence needs independent review. Unlike `list --state unknown`, it also
finds a **completed shadow decision** with a missing or uncertain reported
outcome. It never runs a tool/provider, updates recovery, or changes execution
state. Selection occurs before the bounded keyset page limit.

Each item adds `attention.reasons`, with one or more fixed codes:

| Code | What needs review |
| --- | --- |
| `shadow_outcome_missing` | Completed shadow decision, zero recorded outcome observations. The tool may still be running, may not have run, or its report may be missing; no crash/failure is inferred. |
| `reported_unknown` | Recorded outcome is unknown, with its original provenance retained; not automatically run UNKNOWN. |
| `outcome_conflict` | Recorded observation statuses disagree. No winner is selected. |
| `outcome_unrecognized` | The stored observation status is unsupported; raw text is not displayed. |
| `hook_pairing_pending` / `hook_pairing_blocked` | Claude invocation association is incomplete or ambiguous. |
| `execution_unknown` / `execution_lease_expired` | Durable run UNKNOWN or executing with an expired lease; an operator review does not enable retry. |

The JSON `coverage` explicitly limits the population to decision rows and
excludes pair-only reservations. This is an evidence review list, **not an error
inventory**: ordinary failed reports, admitted/healthy executing calls and
active completed runs without host reports do not enter merely for those
conditions. An empty result proves neither safety nor non-execution. Read the
reported source groups; model-reported data is never upgraded to host evidence.

`attention` accepts `--limit` and `--after`, but not `--state` or `--key`. Use
`inspect` for a returned key. Schema/read-only/privacy limits below still apply.
The [actual Claude cold-resume check](CLAUDE-COLD-RESUME.md) exercises this public
CLI on both uninterrupted and missing-result ledgers, with synthetic transport.

## Pagination and machine-readable receipts

Pages use stable **key order, not chronological order**. The default is 20 rows;
the maximum is 100. Copy the returned cursor to continue. State filters describe
stored admission state, not the outcome reported by a host.

```bash
npm run evidence -- list --db /private/path/shadow.sqlite --limit 20 --after PREVIOUS_KEY
npm run evidence -- list --db /private/path/shadow.sqlite --state unknown
node adapters/evidence-cli.mjs inspect --db /private/path/shadow.sqlite --key KEY --json
```

For JSON, use direct `node` as above or `npm run --silent evidence -- ... --json`;
normal npm banners are not part of the JSON receipt. A missing database or key,
invalid option, or unreadable ledger exits nonzero with a bounded diagnostic.
The inspector never creates a missing database.

JSON adds `hostOutcome.hookPairing: { state, reasonCode }`; the state is
`pending`, `ready`, `blocked` or `not_recorded`. Reason codes are a fixed closed
set, not raw error text, and private pairing tokens are never exported. Read
the pair state together with historical outcome counts: a retained success is
not unambiguous association after a later block. `not_recorded` covers older
schemas and non-Claude adapters; no historical pairing is inferred. Pair-only
reservations without a decision row are outside this decision list. See
[pairing semantics](CLAUDE-HOOK-PAIRING.md).

## Data and compatibility boundaries

The view is a whitelisted, bounded projection. It does not export raw task
summaries, arguments, tool results, prediction distributions, label contents or
audit history. Identifiers and digests are still potentially sensitive metadata,
not anonymization. Unsupported or oversized text fields appear as `null`, not a
silently truncated identity. `metadataCoverage: bounded-projection` makes this
explicit. Stored data is not authenticated or certified by inspection.

Schemas 1, 2 and 3 are read using a read-only SQLite connection and a consistent read
transaction; older schemas are not migrated. SQLite may interact with existing WAL/SHM
sidecars. Read-only application behavior is not a byte-for-byte filesystem
immutability guarantee. Observation counts may require reading existing rows;
bounded output is not a promise of constant query time on an arbitrarily large
ledger.
