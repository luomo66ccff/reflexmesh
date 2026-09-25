# Bound source-pack template: local validation t001

Date: 2026-09-25. This is a local Windows validation of a synthetic ledger,
not real-host, provider-quality, production-ledger or remote-CI evidence.

## User path

`evidence pack-template --db PATH --key KEY --out NEW_FILE` now exports the
original pack associated with one completed, valid recorded prediction. In a
single read transaction it bounds the selected run bodies and pack body, checks
the stored pack ID/version, row digest, full pack digest, event type, question
digest and provider model binding, then validates the recorded prediction. It does not read audit,
observation or label bodies. The full pack is written only to an explicitly
selected, new local JSON file with readback; stdout/JSON contain metadata, not
question instructions. Existing destinations are never overwritten. Replay
remains hypothetical and never grants execution or retry authority.

The retained account-free first-run guide adds an optional exact-key export
command after its policy what-if lesson. The ordinary ephemeral first-run
still removes its lesson; a retained lesson starts with its synthetic
`candidate-pack.json` but does not add `source-pack.json` until the operator
explicitly invokes the new command.

## Local checks

- `npm ci --ignore-scripts` passed.
- `npm run check` passed 931/933 tests, zero failures, two local Windows
  symlink-privilege skips. This was before a final first-run wording correction
  and an additional provider-binding guard. The affected focused tests were
  rerun after those changes (12 passed, one direct-test `npm_execpath` skip).
- `npm run demo` passed, retaining its existing synthetic-only scope.
- A fresh retained first-run directory with Chinese and spaces in its Windows
  path passed on Node 24.19.0 / SQLite 3.53.3. The copied `START-HERE.md`
  `pack-template` command produced a new source pack. Replaying that unchanged
  source returned `allow -> allow`, while the provided edited fixture candidate
  returns `allow -> escalate`. The selected SQLite main-file SHA-256 was
  unchanged across export and replay.
- Focused cases cover new-only output, no overwrite, missing parent, missing
  or UNKNOWN decision, invalid prediction, wrong run/pack binding, tampered
  digest or body, oversized stored pack, no private pack instructions on
  stdout, minimal schema-1 read-only access, and schema-4 empty-metadata
  inspection. The direct first-run integration also checks the generated
  guide and the exported source file without changing the ledger.

## Limits

Pack instructions may be sensitive: the new file needs a private directory and
appropriate OS ACLs; mode `0600` is requested where supported but does not
replace Windows ACL review. A failed write/close may leave an incomplete new
file, which the CLI reports without pretending publication succeeded. Digests
check internal consistency, not authenticity or provenance against an external
attacker. The schema-4 test covers an empty metadata gate, not an actual
archived production ledger. Large-ledger load, adversarial same-user path
replacement, real user profiles and independent model quality were not tested.

PR-head and post-merge CI must be checked separately before claiming remote
integration; the local checks above do not imply that those gates passed.
