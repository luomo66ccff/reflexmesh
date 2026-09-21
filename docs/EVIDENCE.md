# Read a decision without confusing it with execution

ReflexMesh binds a decision to its task evidence, action digest, immutable pack,
and provider deployment. The evidence CLI makes that record readable without
calling a provider, running a tool, retrying an action, or altering a database.

## Start without an account

From a clone with Node.js 22.16 or newer:

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
| `task: ready`, `summary-only` | A selected summary was usable at decision time, not necessarily now. It is not the full request or authorization. |
| `recovery required: true` | Execution remains uncertain. Investigation must not automatically retry the same logical action. |

An operator conclusion such as `confirmed_not_executed` never converts an
UNKNOWN tombstone into retry permission. Use the separate [recovery
runbook](RECOVERY.md) to investigate and record a review.

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

## Data and compatibility boundaries

The view is a whitelisted, bounded projection. It does not export raw task
summaries, arguments, tool results, prediction distributions, label contents or
audit history. Identifiers and digests are still potentially sensitive metadata,
not anonymization. Unsupported or oversized text fields appear as `null`, not a
silently truncated identity. `metadataCoverage: bounded-projection` makes this
explicit. Stored data is not authenticated or certified by inspection.

Schema 1 and 2 are read using a read-only SQLite connection and a consistent read
transaction; schema 1 is not migrated. SQLite may interact with existing WAL/SHM
sidecars. Read-only application behavior is not a byte-for-byte filesystem
immutability guarantee. Observation counts may require reading existing rows;
bounded output is not a promise of constant query time on an arbitrarily large
ledger.
