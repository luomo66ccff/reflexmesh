# Copied selected DeepSeek web stack synthetic native tool — local validation t002

Date: 2026-09-25. Scope: installed DeepSeek Harness **0.1.2-rc.1** on
Windows/Node 24.19.0 with an explicitly selected `web` profile. This extends
the [startup-only t001 check](VALIDATION-DEEPSEEK-SELECTED-WEB-BOOT-T001.md),
not an install into the user's actual profile.

## Reproduce privately

After `npm ci --ignore-scripts`, run:

```powershell
npm run compat:deepseek-web-profile -- --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh' --dsh-home 'D:\DeepSeekHarness\data' --profile web --json
```

The probe first composes the selected profile in isolation and refuses an
already-present observer. It copies only bounded manifest/patch configuration
to a disposable `DSH_HOME`, links installed profile modules, and launches the
selected bundle stack on `127.0.0.1` with an OS-chosen port and no browser.
Its separate CLI overlay loads ReflexMesh in abstain-only shadow mode. A fixed
synthetic model adapter supplies exactly one known tool call; the native Agent
executes a fixed in-memory read tool and returns its result to that adapter.
The probe also handles at most two non-task synthetic requests from Web
features, such as session-title generation. None of these requests use the
account's model credentials.

The resulting private SQLite ledger must contain one shadow decision, the
matching host Agent/session identity, host-reported successful outcome and
zero labels. Fixed checks also cover Web readiness, active Loader row, both
CLI patch arguments, final marker, observer/kernel drain and natural exit.
No raw host stdout/stderr, configuration, model messages or tool result is
printed by the command. Source configuration bytes and file identity are
checked before and after; the disposable home is removed with a guarded path
and identity check.

## Local result and limits

The installed selected Web stack passed **17/17** fixed assertions. The
checked real profile configuration was unchanged, the disposable home was
removed, and the original `127.0.0.1:3080` listener was not started. The
existing isolated CLI Agent probe also passed **13/13** after the shared
synthetic fixture was extended. `npm ci --ignore-scripts`, `npm run demo`
and `npm run check` passed; `check` reported **949 tests: 947 passed, zero
failed, two local Windows symlink-privilege skips**.

This executes the selected third-party Web plugins. Linking modules does not
sandbox their ambient filesystem or network access; selected patch files may
contain secrets. The probe itself does not copy the credential store,
conversations or attachments and does not intentionally request a paid model,
but cannot certify that arbitrary third-party plugins make no background
network calls. It does not prove behavior in the real `DSH_HOME`, browser UI
interaction, default-profile wiring, real-model quality, host authorization
or absence of all bugs. The ledger is local consistency evidence, not
tamper-proof external truth. PR/main CI are separate publication gates and do
not install this local Web stack.
