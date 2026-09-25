# Isolated DeepSeek profile-composition preview — local validation t001

Date: 2026-09-25. Scope: an explicitly selected, locally installed DeepSeek
Harness 0.1.2-rc.1 profile and a proposed abstain-only ReflexMesh Loader row.
No live Agent, model, tool, user ledger or profile installation is involved.

## Reason for isolation

An exploratory direct `--dump-config` against a real profile changed the
modification time of its generated `cordis.yml`; installed host source confirms
`prepareProfile()` writes that file before composing the dump. The prior bytes
were not snapshotted, so no content-identity or rollback claim is made. The
preview never calls dump against the source profile.

## Contract

- Explicit package root, home, profile and proposed database/namespace are
  required. The installed package layout/version and Loader row are checked.
- Only size-bounded profile manifest, profile/home patch and generated root
  fingerprints are read. A local temporary home gets copies of the manifest
  and patches plus a link to installed modules; the host writes its generated
  root only inside that temporary home. Its ACLs inherit the OS temporary
  location and may need independent review if profile config is sensitive.
- Two boot-free composed dumps are captured with output limits and a timeout.
  Raw composed config and host errors, which may contain sensitive settings,
  are not printed. The second dump must include the proposed observer row.
- Checked source files must retain bytes, modification times and identity;
  the temporary module link is removed before bounded recursive cleanup.
  Cleanup uncertainty is a failure with an explicit private path.
- This is configuration composition only. It does not establish current plugin
  loading, profile startup, provider inference, host outcome or permission.

## Local results

The five account-free tests cover parser rejection, isolated overlay success,
already-present observer refusal, redacted dump failure with cleanup, and a
concurrent source change that is reported without rollback. Against the
installed 0.1.2-rc.1 `web` profile, the report was `passed` with current
observer absent, overlay composed, checked source configuration unchanged and
temporary profile removed. The real profile's generated root hash and mtime
remained at the post-exploratory-dump values after this isolated preview.
`npm ci --ignore-scripts` and `npm run demo` passed. `npm run check` passed
**942 tests: 940 passed, zero failed, two local Windows symlink-privilege
skips**. PR-head and main CI are separate publication gates.
