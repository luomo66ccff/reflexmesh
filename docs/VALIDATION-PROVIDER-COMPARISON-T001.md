# Paired comparison validation — t001

Date: 2026-09-22 (Asia/Shanghai). This increment is stacked on PR #15's
`102bb5bd31ac08e61a61b7ed483956b2a752977b`, not merged main. Runtime and
evaluation code tested for the real smoke was the clean commit
`ff450cacbdffd035814541241371db1552c65722`; the subsequent validation/state
commit changes documentation only. No existing PR is merged or retargeted.
Read the published PR's exact-head CI separately; local tests are not CI.

## Offline verification

Windows, Node **22.23.2** and **24.19.0**:

- `npm ci --ignore-scripts --no-audit --no-fund` completed.
- `npm run check`: **676 tests, 675 passed, zero failed, one expected existing
  Windows symlink skip** on each Node version.
- **38 new focused regressions** passed, with no skipped cases.
- All five offline demos passed on both versions: `demo`, `demo:durable`,
  `demo:recovery`, `demo:evidence`, `demo:comparison`.
- The new comparison demo is in the Ubuntu/Node 22 and Windows/Node 22/24
  GitHub Actions matrix; no paid provider run is in CI.

Covered boundaries include strict/frozen schemas and SHA-256 binding,
full-pack capability refusal before egress, all-case receipt preservation,
request budget, failure-stop behavior, cancellation and ignored-abort late
completion, fixed error redaction, model/result conformance, environment
opt-in and construction without egress. Offline transport inspection confirms
that the production DeepSeek adapter receives only approved state/questions,
not the separate label envelope, tools or host context.

Hand-computed report regressions cover binary Brier/ECE, choice accuracy and
summed multiclass Brier, ordinal returned-score MAE/RMSE including accepted
expectation rounding, per-question labels, empty labels/cohort, successful
but nonoverlapping samples, partial predictions, all status denominators,
class/provenance balance, policy transitions on unlabeled both-successful
cases, and distinct provider/model-route declarations. The fixture demonstrates
an apparent unpaired improvement becoming a paired regression (+0.05 Brier).

CLI regressions trap provider factory/environment/network access on local
paths, hash-read back source files, reject overwriting inputs/outputs, check
pre-invocation output reservation, preserve an oversized-finalization marker,
and confirm zero provider calls when re-entering its existing path. A failed
remote-equivalent run leaves a complete failure artifact and does not retry.
Editable-demo output and temporary cleanup are exercised. Arbitrary OS crash,
disk-full/power-loss recovery, hostile-directory races and Windows ACL security
are not certified by these tests.

Scoped independent review found no reproducible P1/P2 within the new contract,
report and execution/file boundaries. Root inspected the code, reran focused
and full tests, and verified actual artifacts. This is not an external security
audit or a claim that no bugs exist.

## Authorized real DeepSeek workflow smoke

On clean `ff450ca`, Node 24.19.0 ran the production evaluation CLI/factory/
runner/report path through an audited fixed-endpoint fetch wrapper. The
wrapper checked exact synthetic state/questions, no tool field, response
statuses and the aggregate four-request ceiling. It delegated requests to
the actual official HTTPS endpoint, not a response fixture.

| Observation | Verified result |
| --- | --- |
| Declared provider / model | `deepseek/binary-json-estimate-v1` / `deepseek-flash` |
| Two deployment IDs | `live-champion-t001`, `live-challenger-t001` |
| Cases | Two synthetic exact-key-equality states per side |
| Calls | **4 total**, four HTTP 200 responses, no retry/fallback |
| Limits | At most 2 requests per side, 128 output tokens/request, 30-second local deadline |
| Returned usage | 948 input + 60 output tokens total; not an invoice |
| Assertions | **14/14 passed** |
| Labels | Two fixed `test-oracle` labels from key equality, never derived from predictions |
| Paired set | 2 labeled, both-successful cases |
| Comparison egress | Zero additional requests; factory/environment trap remained untouched |
| Mutation | Dataset/label bytes unchanged; no host profile read or modified |
| Actions | Zero tools, zero threshold/model changes or promotions |

Both sides use the **same declared model route**. This is a real API workflow
acceptance smoke, not an independent-model benchmark, calibration study or
real-world generalization result. The numbers are model-authored uncalibrated
estimates, not token probabilities or verified confidence. The model route is
an alias, not an immutable weight hash. Two tiny synthetic cases cannot justify
a winner, a quality claim or production authorization.

The locally retained versioned receipt folder is
`tmp/reflexmesh-comparison-live-t001/`: guarded runner, no-retry reservation,
synthetic dataset/labels, both prediction files, report and redacted result.
Only a bounded explicit credential reference was parsed for this authorized
run; no credential value or host profile was logged or committed. Local test
logs are under `tmp/reflexmesh-comparison-validation-t001/`. These directories
are operator-local receipts, not repository dependencies or public data.

## Remaining boundaries

- Real Jev comparison, distinct real model/provider paired cohorts, held-out
  representative labels, class-balanced uncertainty analysis and quality/
  calibration acceptance remain open.
- Imported provenance and label independence remain operator assertions.
  Digests are binding checks, not authenticated signatures or anonymization.
- Paid-run timeout/abort does not prove remote nonreceipt or nonbilling.
  Incomplete output is never automatically retried or repaired. New filenames
  do not establish cross-run idempotency.
- This increment does not change SQLite schema, host hooks, recovery gates,
  authorization or the default abstaining DeepSeek Loader. Actual-host smoke
  results from prior increments are historical, not rerun evidence here.
- Retention, default-profile/complete host lifecycle, migration, privacy and
  broader load testing remain open. See [iteration state](ITERATION-STATE.md)
  and [usage/interpretation limits](PROVIDER-COMPARISON.md).
