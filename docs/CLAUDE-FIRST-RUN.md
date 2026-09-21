# Claude first run: check, review, then verify

`doctor:claude` turns explicit deployment choices into a read-only diagnostic and
a ready-to-review settings fragment. It does not start Claude, read a profile or
credentials, create a database, install hooks, or change settings. The existing
DeepSeek `doctor` command and report format are unchanged.

## 1. Check the explicit setup

On Windows, supply the native Claude `.exe`, a private local execution ledger
path and your deployment namespace. Replace the example paths:

```powershell
npm ci --ignore-scripts
npm run build
npm run doctor:claude -- --claude-executable 'C:\path\to\claude.exe' --db 'C:\ReflexMeshData\shadow.sqlite' --tenant local --scope my-project
```

`npm run doctor:claude -- --help` also works before building. Missing build
artifacts become `build_required`, not a module-import crash. The static
installation check currently supports Windows regular `.exe` files only, not
`.cmd` shims, symlinks or other platforms. It does not read a package manifest,
run `--version`, authenticate the binary or certify any Claude release. Keep
`hostVersion: "unverified"` separate from the independently pinned live probe.
Explicit UNC/network and device-namespace paths are rejected before filesystem
metadata access. This does not detect mapped network drives or every filesystem
alias: choose genuinely local storage, not a network-backed mount.
Windows paths must include a drive letter and root separator; `\ledger.sqlite`
or `/ledger.sqlite` is not an unambiguous deployment path across drives.

| Report field | What it establishes |
| --- | --- |
| `prerequisites` | Node/build presence, production hook entry, explicitly selected file/configuration checks and optional ledger readability |
| `setup.settings` | A proposed fragment, not an installed configuration or permission grant |
| `historicalEvidence` | At most one selected historical record, not current loading or this deployment's identity |
| `liveHost` | Always `live_host_unverified`; doctor never launches the host |

`prerequisites_ready` means those checks passed, not that the host is running.
An absent ledger is normal before first use and is not created by doctor. It
does not prove parent-directory write access, generated-build freshness or
compatibility with every host release and installed plugin.

## 2. Review the fragment, then merge manually

The output contains only `env` and `hooks`: seven events, each calling the
absolute Node executable and production `adapters/claude-task-hook.mjs` through
`command` plus `args`, without a shell. This follows Claude's documented
[exec-form hook configuration](https://code.claude.com/docs/en/hooks#command-hook-fields).
Regenerate the fragment if the checkout or Node path changes. Paths containing
control characters or interpolation syntax are rejected, not escaped into a
different path.

The fragment fixes the observer to shadow/abstain, disallows remote decision
provider access, uses task-aware evidence and **defaults summary capture off**.
It contains no model selection, permissions, tool grants, account settings or
test wrapper. Its `env` entries override inherited ReflexMesh deployment values
under Claude's [environment precedence](https://code.claude.com/docs/en/env-vars#precedence).
They do not authenticate the host or bypass higher-priority organizational policy.

Review the generated fragment before merging its entries into your chosen
settings file. Do not replace unrelated `env` keys or hooks, and do not retain a
second ReflexMesh legacy/task hook for the same event. Duplicate observation
delivery makes [pairing ambiguous](CLAUDE-HOOK-PAIRING.md), even when the command
looks identical. Doctor does not read existing settings, so it cannot detect
your existing duplicates or do the merge for you. Claude's
[settings precedence](https://code.claude.com/docs/en/settings) still applies;
do not remove or override managed policy to make a test pass.

To explicitly opt into selected task summaries, add:

```powershell
--intent-mode explicit-summary --intent-db 'C:\ReflexMeshData\task-intents.sqlite'
```

`--intent-db` is optional; the default is `task-intents.sqlite` beside the
execution ledger. The generator rejects colliding canonical paths. Both modes
include an explicit independent cache path so an inherited cache setting cannot
silently select a different file. Capture off does not open or erase an old
cache. Static checks enforce the ledger's 1024-character limit and reject an
existing non-regular or symlink cache target using metadata only. They do not
open an old cache to certify its contents. Existing cache/ledger formats and
private filesystem access still require the [task evidence](TASK-EVIDENCE.md)
and [upgrade](CLAUDE-HOOK-PAIRING.md) guidance.

Only an opted-in prompt's selected first line is captured:

```text
ReflexMesh-Intent: Inspect README links; do not modify source or deploy anything.
```

The optional cache stores that selected summary in plaintext with bounded
lifetime, not secure-erasure guarantees. Do not put sensitive data in the
summary. The execution ledger retains digests/receipts, not its raw text.
Capture off yields missing task evidence, not fabricated intent. Capture on
does not configure a decision model or create independent truth labels.

## 3. Verify the generated hooks separately

For the tested Windows Claude Code **2.1.263** installation:

```powershell
npm run compat:claude-setup -- --help
npm run compat:claude-setup -- --claude-command 'C:\path\to\claude.exe'
```

Unlike doctor, this opt-in command **starts the installed CLI**, but uses fresh
temporary configuration stores and a synthetic localhost Messages service, not
a real account or model. It obtains the fragment from doctor and uses the
generated `env` and `hooks` unchanged. The child environment deliberately has
no `REFLEXMESH_*` deployment values, so ignoring the fragment cannot silently
fall back to a working preconfigured observer.

Two fresh scenarios test default capture off and explicit-summary opt-in.
Both require a native Read, successful direct hook responses, an exact schema-3
pair and reported outcome, and zero labels. Off must not create a task cache;
opt-in must bind the selected summary and leave an empty cache at process exit.
This direct-entrypoint probe does not attribute exit-time emptiness solely to
Stop; the [separate wrapper-based probe](CLAUDE-LOCAL-LOOP.md) measures that
specific timing and duplicate-delivery behavior.

The probe reuses conservative managed/ancestor refusal and isolated local
transport boundaries. No `--bare`, default-profile access, policy override or
automatic retry is used. Unknown versions/platforms fail closed. The wire model
name is only a fixture label. This is not an OS sandbox, network-egress audit,
real-model certification or proof of every descendant's termination on timeout.
See [local transport limits](CLAUDE-LOCAL-LOOP.md) and the
[dated validation](VALIDATION-CLAUDE-FIRST-RUN.md).

## Inspect historical evidence deliberately

Add `--key KEY_FROM_EVIDENCE_LIST --json` to the doctor command for a selected
record. Without a key, a sample is in key order, **not necessarily latest**.
The report distinguishes decision, task, reported outcome, provenance and
pending/blocked hook pairing. Historical conflicts or UNKNOWN never authorize a
retry. A historical record does not prove it belongs to the proposed tenant,
scope, provider or live process. Use [evidence list/inspect](EVIDENCE.md) for
deliberate browsing.

Use `npm run --silent doctor:claude -- ... --json` or invoke the Node script
directly for JSON without npm banners. Invalid arguments produce fixed errors
without echoing their raw values. Valid settings output intentionally includes
your selected local paths and namespace: review it before sharing. The command
never repairs or migrates a ledger. SQLite read-only inspection can touch WAL/SHM
sidecars; read-only application behavior is not a byte-for-byte filesystem
immutability guarantee.
