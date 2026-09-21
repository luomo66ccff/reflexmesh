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

SQLite can interact with WAL/SHM sidecars even during read-only inspection.
Read-only application behavior is not a guarantee of byte-for-byte filesystem
immutability, and bounded output does not promise constant-time queries on an
arbitrarily large ledger.
