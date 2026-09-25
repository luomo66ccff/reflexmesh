# Policy replay structural-change summary — local validation t001

Date: 2026-09-25. Scope: read-only single-key policy replay against a local
bound source pack. This is an alpha usability increment, not a model-quality,
host-permission or ledger-authentication claim.

## Behavior and evidence

- The replay read transaction already verifies the bound source pack, original
  prediction and stored verdict. It now returns only the source rules and
  fallback to the local receipt builder; question instructions are excluded.
- The receipt counts added, removed and structurally modified rules, compares
  the relative order of common rule IDs and detects fallback changes. It does
  not print rule conditions or directives beyond the already shown winning
  verdict. Metadata-only version changes leave `structureUnchanged: true`.
- Missing source bodies in stripped schema-1 fixtures retain replay
  compatibility but yield `policyChanges.status: legacy_unverified`; newer
  schemas without the pack table still fail closed.
- The summary is structural, not causal attribution or proof of semantic
  equivalence. Rule edits may not change the selected verdict, and a model is
  never re-run. The ledger is not authenticated against a capable local writer.

## Local checks

Tests were written first and failed on the absent `policyChanges` field.
After the final projection refinement, focused replay and pack-template tests
passed **18/18**. `npm ci --ignore-scripts`, `npm run check` (**937 tests, 935
passed, zero failed, two local Windows symlink-privilege skips**), `npm run
demo` and the account-free `npm run first-run` passed on Node 24.19.0 / SQLite
3.53.3. The full check and demo were rerun after the final code change.
The fixture covers a version-only candidate, one modified threshold, add/remove,
shared-rule reorder and fallback change, as well as ignored extra prose,
legacy unavailability and private source-question suppression. GitHub CI is a
separate publication gate; no live profile or paid provider was used.
