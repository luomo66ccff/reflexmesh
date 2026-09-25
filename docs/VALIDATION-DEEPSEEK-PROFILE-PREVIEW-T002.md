# Isolated DeepSeek overlay export — local validation t002

Date: 2026-09-25. Scope: optional new-file export after the explicit-profile,
boot-free composition preview introduced in [t001](VALIDATION-DEEPSEEK-PROFILE-PREVIEW-T001.md).
This is not profile installation or a live-plugin acceptance test.

## Contract and failure boundaries

- `--out-overlay` is optional. It must name an absolute new file whose parent
  exists outside the selected real `DSH_HOME`. Existing destinations are never
  overwritten, including if they appear after preflight.
- The same isolated host composition, checked source-file stability and
  temporary-home cleanup must pass before any output file is opened. A failed
  preview or concurrent source change publishes nothing.
- The output is the proposed Loader insertion fragment, not a merged profile.
  It is created new-only, synced, read back byte-for-byte and reported with
  byte count and SHA-256. The digest identifies the exported bytes; it is not
  a signature or proof of the host/plugin's future behavior.
- If publication fails after creation, the result is `overlay_file_unverified`
  with a path to inspect privately. The tool does not delete that potentially
  incomplete file or assume it is safe to use. The destination directory's
  privacy and ACL remain the operator's responsibility.
- No selected profile is patched or started; no provider, model, user ledger
  or host tool is invoked. Manually starting a real host with `--patch` is a
  separate operation that may rewrite its generated `cordis.yml`.

## Local results

The focused suite passed **7/7**. New cases cover verified new-file export,
existing/profile-home/relative/missing-parent rejection before dumping, and no
publication after a concurrent source change. The tests were first run before
implementation and the two new behavior cases failed as expected.

Against the locally installed DeepSeek Harness **0.1.2-rc.1** `web` profile,
the isolated CLI report was `passed`: current observer `absent`, overlay
`composed_in_isolation`, checked source configuration unchanged, temporary
profile removed, live host `not_started`, model calls `0`. A new temporary
overlay was created and independently hashed to match the receipt
`8a20ed8ad213dde4950dcb52bfcb9cb0905c1d9c4078a95858c764c690970c69`.
The selected profile's generated root file retained its pre-check SHA-256 and
UTC modification time. The verified test overlay was then removed; no real
profile patch or ledger was written by this check.

`npm ci --ignore-scripts` and `npm run demo` passed. `npm run check` passed
**944 tests: 942 passed, zero failed, two local Windows symlink-privilege
skips**. PR-head and main CI remain separate publication gates.
