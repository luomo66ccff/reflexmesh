# Attention and Claude cold-resume validation

Verified locally on **2026-09-22 (Asia/Shanghai)** on Windows, installed Claude
Code **2.1.263**, Node **22.23.2 / 24.19.0**. Branch `feat/evidence-attention`
is based on PR #13's `380b156`, not merged main. CI results must be checked on
the exact published head; this report does not treat previous PR CI as current.

## Evidence observed

- Both installed-host scenarios passed **20/20 assertions each** on each Node
  version: clean exit/resume with summary replacement, and tool-entry barrier
  termination/resume without inheriting the old summary.
- Each scenario used two different, closed native processes and the same
  isolated persisted session through an explicit transcript path. Local
  Messages requests proved the earlier synthetic history was restored.
- Before termination, the tool had actually entered, its original call was
  persisted, and the production pre-hook had recorded a completed shadow
  decision with ready pairing and no outcome. The owned process was then
  force-terminated; no arbitrary sleep was treated as crash evidence.
- Public `evidence attention` returned precisely that old missing-result row
  after resume, with completed shadow state and `recovery.required=false`.
  The clean scenario returned no attention rows. Old records stayed unchanged;
  new IDs had their own exact task/action/result evidence and zero labels.
- Both generations used unchanged doctor-produced production hooks. Hook
  events were paired and ordered with successful responses; observer warnings
  failed acceptance. Node 22's exact SQLite warning was allowed separately.
- A root-run actual-host negative control removed all generated hooks. The
  native synthetic tool completed successfully, but the probe correctly failed
  with `persisted_ledger_missing`, before attempting resume. It was not counted
  as compatibility success.

The first exploratory killed-resume run failed a history assertion: Claude
replaced its unfinished tool-use Messages block with a fixed placeholder on
resume. The pinned fixture now validates that exact transformation and retains
the original transcript/ledger evidence; it never interprets the placeholder as
a tool outcome or claims arbitrary host versions share this behavior.

## Offline regression and review

`test/evidence-attention.test.mjs` covers selection/projection agreement, multiple
reasons, missing vs execution UNKNOWN, reviewed UNKNOWN, source provenance,
keyset filtering before limits, one clock snapshot, schema 1/2/3 read-only access,
pair-only coverage exclusions and privacy. `test/claude-resume.test.mjs` covers
strict history roles/order/results, fixture refusals, bounded owned processes,
exact transcript selection and lifecycle warning/pairing failures. Together:
**57 new tests**, all passed locally on both Node versions.

Root verified independent review findings and fixes: malformed history could
previously pass, an MCP protocol failure after success lacked a visible negative
signal, lifecycle warnings could be accepted, and attention text could misname
model-reported data as host reports. Counterexample regressions now reject these;
human attention rows preserve source counts and neutral outcome wording.

Final full suites on both Node versions: **539 tests, 538 passed, zero failed,
one expected Windows symlink skip**. `npm ci --ignore-scripts`, typecheck/build
and all four offline demos passed. No new schema, execution permission, retry,
provider invocation or automatic labeling was added. Exact-head three-platform
CI receipts are recorded with the PR validation after publishing.

## Not established

This is actual installed-host execution with **synthetic model transport**, not
real model inference, calibration, a second provider or default-profile
certification. It covers explicit new-prompt resume, not unattended continuation,
forked/resumed children, every descendant's termination, actual cancellation
hooks, arbitrary external effects or all cross-host restart behavior. Shadow
observation cannot prevent a host from re-executing a tool. There is no global
no-bugs or external exactly-once guarantee.

All probe-created synthetic temp profiles/transcripts/ledgers were removed after
closing resources and checking exact cleanup targets. Existing user sessions,
settings, credentials and project source data were not altered by the probes.
See [reproduction and boundaries](CLAUDE-COLD-RESUME.md).
