# Single-side evaluation score: local validation t001

Date: 2026-09-25. Scope: offline scoring of one existing provider prediction
artifact against a separately supplied labelset. This is a local candidate,
not PR/main integration, a new model request or a representative benchmark.

## User-facing gap and change

The paired `compare` command correctly requires two distinct deployments,
but a first-time operator has only one run. Fabricating a champion from that
same file would create a meaningless paired delta. The new
`npm run evaluation -- score --dataset FILE --labels FILE --predictions FILE`
branch reuses the existing validators and metric functions while keeping a
separate report kind, `reflexmesh-evaluation-score`.

For each question it reports all-case and labeled-case status coverage,
class balance for all labels and the successfully scored subset, and binary
Brier/ECE, choice accuracy/multiclass Brier or ordinal MAE/RMSE on only the
labeled successful rows. Zero scored rows produce `metrics: null`, not a
fabricated zero. The artifact binds dataset, labelset, prediction and
deployment digests, marks origin/label independence as unverified
declarations, and keeps `executionAllowed` and `promotionAllowed` false.
There is no comparator, paired delta, policy transition or tool invocation.
The command reads no credentials, host profile or network and writes only an
explicitly new optional report file.

## Exact local readback

- The previously retained canonical `deepseek-flash` synthetic prediction
  receipt and its precommitted eight labels yielded 8/8 scored, 4 positive
  and 4 negative labels, Brier **0.0012** and 10-bin ECE **0.03**.
- The previously retained first-attempt receipt yielded 0/8 scored: one
  `provider_error`, seven `stopped_after_failure`, no successful row and
  `metrics: null` (`no estimate` in human output). The original remote
  reception/billing uncertainty is unchanged.
- Both commands created new, private local JSON score reports beside the
  original receipts. No prediction receipt was modified, no model/key was
  accessed, and neither score artifact was published to GitHub.

## Verification and limits

- Focused CLI/report tests: **32/32 passed**. They cover binary, choice and
  ordinal metrics; partial labels; missing/failed rows; empty scored subsets;
  invalid identities/answers; source no-overwrite; and zero environment,
  provider or network access.
- `npm ci --ignore-scripts`: pass, zero reported vulnerabilities.
  `npm run check`: **878 passed of 880**, zero failed and two local Windows
  symlink-privilege skips; typecheck/build passed. `npm run demo`: pass.
- The live DeepSeek outputs and synthetic targets come from the earlier
  [catalog-gated local validation](VALIDATION-EVALUATION-CATALOG-LIVE-T001.md).
  Re-scoring them does not independently verify origin, label truth,
  population representativeness, calibration or generalization. It does not
  compare Jev, establish default-profile support or close the long-term
  product objective.
