# Copied selected DeepSeek web stack startup — local validation t001

Date: 2026-09-25. Scope: installed DeepSeek Harness **0.1.2-rc.1** on
Windows/Node 24.19.0, explicitly selected `web` profile. This advances from
the [boot-free selected-profile composition](VALIDATION-DEEPSEEK-PROFILE-PREVIEW-T001.md)
and [empty-bundle CLI overlay Agent probe](VALIDATION-DEEPSEEK-OVERLAY-BOOT-T001.md).

## What the check does

- Requires the isolated composition preview to pass first, with no existing
  observer, stable checked source files and verified temporary cleanup.
- Copies only size-bounded `package.json`, profile patch and optional home
  patch to a new disposable `DSH_HOME`; links the profile's installed modules.
  The selected generated root is fingerprinted, not copied. Credential-store
  and conversation files are not copied by the probe.
- Starts the installed `web` bundle stack with an abstain-only Loader overlay
  and a one-shot readiness fixture. Web is forced to bind `127.0.0.1` on an
  OS-selected port with `--no-open`. After `appReady`, the fixture verifies
  actual Loader activation, profile-tree binding, CLI overlay arguments and
  loopback Web service, then requests host-owned exit.
- Requires exit-time observer drain and kernel close plus natural Node
  `beforeExit`. Raw host stdout/stderr, which may contain a Web token or
  configuration, are captured within limits but never printed. The selected
  source files are checked again; temporary cleanup is identity/path guarded.

The selected profile currently lists six bundles: official base/web and four
third-party UI extensions. Therefore this command **runs third-party plugin
code**. It does not sandbox that code's ambient filesystem or network access;
profile/home patch files may themselves contain secrets. Only run it against
a trusted installation. The probe sends no user task and requests no model or
tool, but does not claim arbitrary plugins make zero background network calls.

## Local results and exclusions

Test-first the new command was absent and the focused test failed. After
implementation, the installed selected `web` stack passed **8/8** fixed
assertions, including `appReady`, active ReflexMesh Loader row, both CLI
overlays, loopback Web service and natural observer/kernel cleanup. The
temporary home was removed. The real profile's generated `cordis.yml` retained
its pre-check SHA-256 and UTC modification time; no listener remained on the
original 3080 port. The probe did not itself read the real credential store or
conversation data, and made no paid model request; selected third-party plugins
retain ambient access that this check does not audit.

This does not prove installation in the real `DSH_HOME`, every third-party
plugin behavior, a user-facing tool call, model inference, host authorization,
or universal absence of bugs. `npm ci --ignore-scripts`, `npm run demo`,
`npm run demo:durable` and `npm run demo:recovery` passed. `npm run check`
passed **948 tests: 946 passed, zero failed, two local Windows
symlink-privilege skips**. Exact PR/main CI remain separate publication gates;
their offline tests do not install or boot the selected Web plugin stack.
