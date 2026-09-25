# Copied selected DeepSeek Web UI first evidence — local validation t001

Date: 2026-09-25. Installed DeepSeek Harness: **0.1.2-rc.1**. Platform:
Windows, Node 24.19.0, Edge through `playwright-cli`. This milestone extends
the [copied selected Web tool check](VALIDATION-DEEPSEEK-SELECTED-WEB-TOOL-T002.md)
with a real browser submission and a retained, inspectable synthetic ledger.

## Reproduce privately

After `npm ci --ignore-scripts`, run the command below with a trusted selected
installation and a **new private** output directory:

```powershell
npm run compat:deepseek-web-first-evidence -- --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh' --dsh-home 'D:\DeepSeekHarness\data' --profile web --out-dir 'C:\ReflexMeshData\web-evidence-t001' --ack-selected-plugins
```

The command preflights composition and refuses a duplicate observer or an
already-running installed host. It copies bounded manifest/patch files, not
the credential store or conversations, into a disposable `DSH_HOME`; links
selected installed modules; adds the observer and a fixed synthetic model/tool
through temporary CLI overlays; then starts Web on loopback with an OS-chosen
port. It writes the authenticated URL only to a private temporary file.
Open that URL locally, choose the temporary workspace, verify **read-only**
access and `reflexmesh-synthetic/fixture-v1`, then send exactly the printed
two-line task once. After the page shows the fixed marker, press Enter in the
terminal. The command verifies the host/session/tool-result binding, zero
labels, natural drain/exit and source-config readback, then copies one SQLite
ledger plus `START-HERE.md` into the new output directory. The ledger can be
inspected with the command in that guide; it is not a production ledger.

## Observed result

The final installed-host/browser run passed **21/21** gates and exited 0.
Edge displayed the synthetic model and read-only access mode, the exact
browser-submitted task, one `reflexmesh_fixture_read · synthetic-only` call,
input `{ "key": "synthetic-only" }`, output `synthetic-read-ok`, and final
`REFLEXMESH_SYNTHETIC_AGENT_OK`. A separate read-only `evidence list` of the
retained ledger showed exactly one completed shadow run, an `escalate`
abstention decision, host-reported `succeeded`, and a ready task. The command
verified unchanged checked source config and removal of its disposable home.
`npm ci --ignore-scripts`, `npm run demo`, `npm run demo:durable`,
`npm run demo:recovery` passed; `npm run check` reported **962 tests: 960
passed, zero failed, two local Windows symlink-privilege skips**.

The first browser attempt encountered an unusable native Windows directory
picker under headless Edge. A second attempt added a duplicate picker and
failed the Web plugin load. After selecting the host's browser-capable picker,
the browser task succeeded, but an earlier 180-second manual confirmation
window expired before final evidence retention. The final implementation uses
the browser-capable picker and a 600-second manual window. None of those
failed attempts was counted as a passing gate or published as evidence.

## Boundary

The page and ledger prove one local synthetic Web flow, not general browser
origin attestation, real-home UI installation, paid-model behavior, model
quality, plugin isolation or absence of all bugs. ReflexMesh remained
shadow/advisory and made no permission change or automatic retry. The CLI did
not intentionally request a paid model or copy personal sessions, but selected
third-party plugins run with ambient filesystem/network access. During this
browser check the installed market frontend made a telemetry request despite
the probe setting `DSH_TELEMETRY_DISABLED=1`; do not read this as a no-network
or no-exposure guarantee. The temporary token URL, copied patches, failure
directories and private ledger must not be published. PR and main CI are
separate gates from this local installed-host acceptance.
