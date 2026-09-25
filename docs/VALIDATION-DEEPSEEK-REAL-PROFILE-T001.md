# Selected real DeepSeek Web home synthetic tool acceptance — local t001

Date: 2026-09-25. Installed DeepSeek Harness **0.1.2-rc.1**, Windows,
Node **24.19.0**, explicitly selected `web` profile. This advances the
[copied-profile synthetic tool check](VALIDATION-DEEPSEEK-SELECTED-WEB-TOOL-T002.md)
to the actual selected `DSH_HOME`; it is still an opt-in synthetic task, not
ordinary user deployment or a paid-model test.

## Gate and command

Before startup, the operator stopped other Harness processes and created a
private, versioned archive outside `DSH_HOME`. Archive SHA-256 was checked and
all **28 non-dependency ordinary files** in the real home (including the
credential document, sessions, attachments, settings and plugin state) were
read back byte-for-byte from it. The archive expands Windows dependency
reparse points, so it does not preserve link topology for a blind whole-tree
restore. Its path, hash and any private content stay outside this repository.
On Windows the command also checks for an already-running installed Harness
process before archive validation and again immediately before boot. This is
a bounded process-state check, not an OS-wide lock against a new concurrent
launch.

```powershell
npm run compat:deepseek-real-profile -- --deepseek-package-root ABS_INSTALLED_DSH_PACKAGE --dsh-home ABS_REAL_DSH_HOME --profile web --backup-archive ABS_PRIVATE_DATA_TAR --backup-sha256 SHA256 --ack-real-home-writes --json
```

The check first performs isolated configuration composition and refuses an
already-loaded ReflexMesh observer. It then boots the installed selected
profile from its real home using two **temporary CLI overlays**, loopback and
an OS-chosen port. ReflexMesh remains shadow/abstain. A fixed synthetic model
adapter drives one in-memory native read; the private temporary ledger must
show one matching host-reported result, exact Agent/session identity and zero
labels. No real model or filesystem tool is requested.

The overlay redirects fixture session persistence, JSON storage and pet state
to the disposable directory. Before and after startup, the probe inventories
ordinary files and reparse-point identities outside `node_modules`, allowing
only the host-generated `profiles/web/cordis.yml` to change. It checks that
this generated file did not persist the observer row. Raw host output,
credentials, session content and fixture responses are not printed.

## Actual result and correction

The first run completed the 17 core startup/Agent/tool/ledger checks but
**failed** the real-home mutation gate: the selected pet plugin changed
affinity/treat counters and the host created one synthetic session projection
cache file. The changed pet file and synthetic cache were retained privately;
the pre-run pet bytes were restored from the archive. An independent
byte-for-byte comparison then found all 28 non-dependency ordinary files equal
to the archive. The generated root's content hash was unchanged; its
modification time had changed.

After the pet and JSON-storage redirects were added, the actual selected
profile passed **20/20** checks. A final run with complete ordinary-file
archive readback also passed **20/20**: one synthetic native tool call, one
shadow decision with host-reported success, abstain binding, zero labels,
natural observer/kernel cleanup, verified archive, no other non-dependency
file changes and verified temporary cleanup. The real pet file retained its
restored pre-run hash, the generated root retained its pre-run content hash,
no Harness process or listener remained, and no permanent ReflexMesh row was
installed. The generated root's modification time was still updated by the
host; this is an explicit side effect, not byte/metadata identity.
`npm ci --ignore-scripts`, `npm run demo`, `npm run demo:durable` and
`npm run demo:recovery` passed. `npm run check` reported **956 tests: 954
passed, zero failed, two local Windows symlink-privilege skips**. Exact PR and
main CI are separate publication gates.

## Limits

The selected third-party Web plugins execute with normal ambient filesystem
and network access. Redirecting known write paths does not sandbox them, and
the inventory does not hash dependency trees or detect arbitrary external
effects. The archive gate checks ordinary user-state files but does not prove
full Windows junction reconstruction. The probe creates an Agent directly
after Web readiness; it does not exercise browser UI task entry, the user's
ordinary model route, all tools, another profile or a long-running service.
This evidence is not a security certification, a model-quality benchmark or
proof that all project bugs are absent. CI tests the account-free contract;
the real-home run is an explicitly local acceptance step.
