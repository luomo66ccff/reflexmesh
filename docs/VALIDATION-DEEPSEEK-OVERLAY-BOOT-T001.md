# Installed DeepSeek CLI overlay boot — local validation t001

Date: 2026-09-25. Tested installation: DeepSeek Harness 0.1.2-rc.1 on
Windows with Node.js 24.19.0. This closes a narrow gap between an overlay
that composes in the [selected-profile preview](VALIDATION-DEEPSEEK-PROFILE-PREVIEW-T002.md)
and an observer that actually loads from the installed CLI `--patch` path.

## Change and evidence boundary

The existing isolated Agent probe now keeps only enumerated host and fixture
rows in its empty-bundle profile patch. It generates the ReflexMesh Loader row
with the same `loaderInsert` helper used by profile preview, writes that row to
a separate new temporary file, and passes the file as `--patch` to the
installed CLI. The fixture checks that the base profile patch has no observer,
the CLI argv points at the overlay, that overlay contains the expected Loader
URL/ID, and the actual Loader entry is active in the temporary profile tree.
This fixture explicitly selects `intentMode=explicit-summary` to exercise the
task receipt; the user-facing profile preview defaults to `intentMode=off`.
The test covers the same generator and CLI overlay mechanism, not byte-identical
preview output or the selected profile's plugin stack.

The probe still checks a native in-memory tool call and matching result,
host-declared selected task receipt, abstain-only ReflexMesh binding, one
harness-reported outcome, zero labels, and observer drain/kernel close before
natural exit. No user profile, default bundles, credentials, model inference,
filesystem/network tool or real ledger is loaded. The temporary home and
ledger are removed only after closing the read handle and guarded cleanup.

## Local results

- Test-first patch introduced a missing-export failure before the generator
  existed. Focused offline probe/transport tests then passed **19/19**.
- Actual installed `agent-cli` probe passed **13/13** assertions; the new
  `observer_overlay_via_cli` check was true. Reported evidence level remains
  `cli_agent_loop`, transport `synthetic_adapter`, classification `abstain`,
  `modelInference=false`, and `agentE2E=false`.
- `npm ci --ignore-scripts`, `npm run demo`, `npm run demo:durable` and
  `npm run demo:recovery` passed. `npm run check` passed **944 tests: 942
  passed, zero failed, two local Windows symlink-privilege skips**. PR-head
  and main CI are separate publication gates; they do not install the
  DeepSeek package in CI.

This does not run the optional file exported for a real selected profile, nor
prove compatibility with that profile's other plugins, default profile,
real-model inference, host permission semantics or arbitrary tool side effects.
