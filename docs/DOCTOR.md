# First-run doctor: prerequisites are not a live-host certificate

This page describes the DeepSeek `doctor` command. Claude users can
use the separate [Claude first-run doctor](CLAUDE-FIRST-RUN.md), which generates
direct production-hook settings without modifying an existing installation.

Use the read-only doctor before connecting DeepSeek or when a first-run record
is missing. It does not start a host, call a provider, inspect a user profile,
read credentials or change settings. It can run before the TypeScript build so
that a missing build becomes an actionable diagnostic rather than an import
stack trace.

```bash
npm run doctor -- --help
npm run doctor
```

Without arguments it reports the missing explicit configuration. For a complete
check, choose a trusted installed DeepSeek package and a private local database
path, then supply your deployment namespace:

```powershell
npm run doctor -- --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh' --db 'C:\ReflexMeshData\shadow.sqlite' --tenant local --scope my-project
```

Replace these example paths and names. Namespace names separate records, not
authenticate a person or grant permission. A package version check is not an
integrity or security audit of that installation.

The output gives fixed diagnostics, next actions and, when the explicit
configuration is valid, an insertion snippet for `cordis.patch.yml`. Review and
apply that snippet yourself using the [Loader guide](DEEPSEEK-AGENT.md). Nothing
is installed automatically. The proposed configuration keeps task capture
**off**, leaves permission decisions with the host and uses the **abstain**
provider. It does not inherit provider settings or keys from the environment.

## Understand the three separate questions

Both doctors now report the actual in-memory SQLite runtime probe separately
from the Node API floor. A blocked WAL write gate requires manual runtime
selection and restart; it does not prevent historical read-only diagnosis or
mean the selected ledger is corrupt. See [SQLite runtime](SQLITE-RUNTIME.md).

| Question | What doctor can establish |
| --- | --- |
| Are the checked prerequisites present? | Node version, local build artifacts, explicitly selected installation and configuration checks |
| Does this selected ledger contain historical evidence? | A bounded read-only projection of an existing local database, optionally selected by key |
| Is the current host running with this plugin? | **Unverified.** Neither files on disk nor historical records prove current loading |

An absent database is normal before the plugin's first use; doctor does not
create it. An empty database or missing selected key does not prove installation
failed. An existing database that cannot be read or has an unsupported schema
needs attention, not an automatic repair or migration.

To request one particular historical record:

```powershell
npm run --silent doctor -- --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh' --db 'C:\ReflexMeshData\shadow.sqlite' --tenant local --scope my-project --key KEY_FROM_EVIDENCE_LIST --json
```

Without a key, any sampled row is in key order, **not the newest call**. A
historical record may be from a different deployment than the configuration you
are planning. It cannot prove your current profile, tenant or scope is loaded.
Use [evidence list/inspect](EVIDENCE.md) for deliberate browsing.

Missing task evidence is expected with capture off. An unavailable provider is
expected with abstain. Neither is silently converted into a fabricated
assessment or permission. A completed decision is not a tool result, reported
success is not a truth label, and conflicting/UNKNOWN outcomes never imply it
is safe to retry.

A completed shadow decision and an unknown reported host outcome can coexist.
Doctor warns about that unknown outcome even when the decision row is completed;
it does not turn the row into an execution tombstone or enable recovery/retry.
Likewise, `historical_outcome_missing` means an earlier shadow decision has no
recorded host result. It does not mean the tool failed, did not run or can be
retried. Check the host's own status first, then use `evidence attention` and
`evidence inspect --key KEY` for the selected row. This informational diagnostic
does not make an otherwise ready installation fail its prerequisite check and
does not relabel the durable run as `unknown`.

A selected Claude record also exposes `historicalEvidence.hookPairingState`.
Pending or blocked association emits `historical_hook_pairing_unavailable`,
including when an older success report remains. That report cannot establish
unambiguous invocation association. This is a historical evidence warning, not
a Claude installation check or a new execution status; see [pairing](CLAUDE-HOOK-PAIRING.md).

## Machine-readable output and limitations

Add `--json` for the versioned report; use direct `node` or `npm run --silent`
to avoid npm banners in machine-readable stdout. Help exits 0; unmet prerequisites or
invalid options exit 1. Read the individual diagnostics: an exit code alone
does not prove a live connection or successful host execution.

Doctor performs no schema migration, writable database open, model inference,
policy replay or tool execution. It does not prove filesystem write access,
the freshness of generated build artifacts, compatibility of arbitrary host
plugins or successful real-model behavior. Full live testing remains separate
and requires an explicitly authorized profile, data scope and model budget.

## Preview an existing profile without editing it

For an explicitly selected DeepSeek profile, run the separate isolated
composition preview after building the project:

```powershell
npm run compat:deepseek-profile -- --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh' --dsh-home 'D:\DeepSeekHarness\data' --profile web --db 'C:\ReflexMeshData\shadow.sqlite' --tenant local --scope my-project
```

Replace all paths and identifiers. This is **not** the read-only doctor: it
reads only bounded `package.json`, profile/home patch files and the generated
root file, then copies the manifest and patches into a local temporary home.
It links the selected profile's installed modules, runs the pinned host's
boot-free `--dump-config`
there twice (before and after a temporary ReflexMesh overlay), suppresses the
raw composed configuration, then removes the temporary home. It reports whether
the observer is already in the composed config, whether the proposed overlay
appears, whether the checked source config files kept their bytes, modification
times and file identities,
and whether cleanup was verified. Existing profile settings, credentials and
the real ledger are not intentionally changed; no host Agent, provider or tool
is started. An unexpected concurrent source-file change is reported, not
rolled back. An unverified cleanup returns the temporary path for private
inspection; profile configuration may itself contain secrets, and the
temporary directory inherits the OS temporary location's access controls.
Do not paste its contents into an issue or chat.
`absent` means the known observer ID/URL was not seen in the composed dump;
renamed or differently resolved entries, relative runtime imports, plugin
startup and tool behavior are not certified by this preview.

Do not use a direct `dsh --profile web --dump-config` against a real profile as
a byte-for-byte read-only check: installed Harness 0.1.2-rc.1 rewrites its
generated `cordis.yml` during profile preparation, even without booting plugins.
The isolated preview avoids that source-profile write. A successful preview is
only configuration composition, not proof that the observer loads or works in
the default profile. The profile remains unchanged until you separately choose
to install and start it; see the [Loader guide](DEEPSEEK-AGENT.md).

SQLite can interact with WAL/SHM sidecars even during read-only inspection.
Read-only application behavior is not a guarantee of byte-for-byte filesystem
immutability, and bounded output does not promise constant-time queries on an
arbitrarily large ledger.
