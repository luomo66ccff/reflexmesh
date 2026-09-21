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
npm run demo:evidence
```

The walkthrough builds the project and shows four stages: missing task evidence,
a recorded decision with no host result yet, a separately reported result, and a
cleared task. Repeating the same decision reuses its evidence. Clearing the task
does not reuse its old summary. Classification and outcomes are explicitly
**synthetic fixtures**; no model or real host tool runs. Temporary SQLite files
are closed and removed at exit. This is a product walkthrough, not an accuracy
benchmark or a live integration test.

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
