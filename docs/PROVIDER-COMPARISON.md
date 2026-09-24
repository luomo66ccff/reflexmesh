# Paired provider comparison

Compare answers to the same versioned question contract without confusing
missing answers, execution outcomes or confidence with independent truth.
This workflow is separate from the SQLite ledger and host hooks. It neither
executes tools nor changes authorization, thresholds or deployed models.

## Start without an account

```bash
npm ci --ignore-scripts
npm run demo:comparison
npm run demo:comparison -- --out-dir comparison-lesson
```

The first demo removes its temporary synthetic files. The second requires a
new directory and preserves five editable JSON files: dataset, labels,
champion predictions, challenger predictions and report. It refuses to
overwrite an existing directory.

The fixed equality oracle produces labels separately from mock predictions.
The candidate answers only two of four cases, fails the third, then stops:

| Binary Brier (lower is better) | Champion | Challenger |
| --- | --- | --- |
| Each side's own available subset — **not a valid direct delta** | 0.20 over 4 | 0.09 over 2 |
| Same labeled, both-successful cases | 0.04 over 2 | 0.09 over 2 |

The paired delta is **+0.05**, not an improvement. This is a hand-designed
lesson about selection bias, not a benchmark or real-model quality claim.
Paired analysis also cannot remove selection bias relative to the omitted
cases: always inspect coverage and class balance.

```bash
npm run evaluation -- validate --dataset comparison-lesson/dataset.json --labels comparison-lesson/labels.json
npm run evaluation -- compare --dataset comparison-lesson/dataset.json --labels comparison-lesson/labels.json --champion comparison-lesson/champion.json --challenger comparison-lesson/challenger.json
```

Use `--json` for the complete machine-readable report, `--bins N` to select
1–100 binary ECE bins, and `--out NEW_FILE` to preserve the report. Build with
`npm run build` before invoking the adapter directly on a clean checkout.
Validate and compare do not load provider configuration or credentials.

Before authorizing a paid run, preview the same trusted capability gate used
by the runner, without a key, provider construction, label file or network
request:

```bash
npm run evaluation -- plan --dataset comparison-lesson/dataset.json --provider deepseek --max-requests 2
npm run evaluation -- plan --dataset comparison-lesson/dataset.json --provider deepseek --max-requests 2 --json
```

Without a declared model route, `plan` reports **capability-only** compatible
and unsupported counts, the capability request upper bound, and canonical
`{state, questions}` bytes for selected cases. `wirePreflight.status` is
`not_checked`: those counts do not promise that a full HTTP body can be sent.
With both `--model-id` and `--provider-revision`, the separate
`wirePreflight` section checks the exact locally serialized provider request
body against its byte limit. It reports sendable and wire-rejected cases, a
wire-aware request upper bound, and selected request-body bytes. DeepSeek uses
512 output tokens by default; `plan --max-output-tokens N` checks another
explicit DeepSeek limit. Jev has no output-token option. Neither mode prints
raw state, case IDs or question text, reads labels or accesses a key/network.
The model route, endpoint availability, response validity, latency, remote
billing and monetary cost remain unverified; a first failure or cancellation
can reduce the actual request count. A dataset can already contain secrets or
labels, so review outbound data and account budget separately before run.

The preview also prints a `Plan guard` (JSON field `guardDigest`). To catch an
accidental edit or route/cap change between preview and a paid run, copy that
lowercase SHA-256 value into the run command as
`--expect-plan-digest SHA256_FROM_PLAN`. This optional check binds the
canonical dataset digest, selected `deepseek`/`jev` provider, request cap and
trusted capability declaration. It fails **before** provider/key access or
output-file reservation if any of those changed. A matching guard is only an
accident-prevention check: anyone with the dataset can recompute it, and it
does not bind a model ID, model revision, price, account, label, actual wire
body or human approval. Keep the explicit `--allow-remote` and environment
opt-in; review the current dataset and route before each paid run.

To catch a changed **declared model route**, supply its account-supported
model ID and your evaluated revision to an offline plan:

```bash
npm run evaluation -- plan --dataset comparison-lesson/dataset.json --provider deepseek --max-requests 4 --model-id MODEL_ID_FROM_ACCOUNT --provider-revision EVALUATED_REVISION
```

This prints a separate `Route guard` (JSON field `routeGuardDigest`).
Copy it to the same run command as
`--expect-route-plan-digest SHA256_FROM_ROUTE_PLAN`. The route guard also
binds the earlier dataset/provider/capability/request-cap plan and the
trusted provider ID. At run time it compares the current
`REFLEXMESH_PROVIDER`, matching model variable and
`REFLEXMESH_PROVIDER_REVISION` **before** reading the key, constructing
the provider or reserving output. The checked route is held stable through
provider construction, and the constructed binding is compared before the
output file is opened. The older `--expect-plan-digest` remains available
and does **not** bind model/revision. Both options may be supplied.

The model ID and revision are operator declarations, not independently
verified remote identity. Aliases can change weights; the digest is not a
signature, authorization, price or monetary limit. It does not bind the
account, output-token cap, timeout, serializer version, actual request bytes
or labels. A route-declared local body check is not a guard for that body:
the run rechecks its actual provider configuration before every request.
Review data egress and account controls separately.

## Three separate input artifacts

All schemas have `schemaVersion: 1`, exact fields and finite plain JSON.
Files must be explicit regular files, not symlinks, at most 4 MiB, valid UTF-8.
The directory is a trusted local boundary, not an OS sandbox. No config,
profile, `.env`, ledger or credential-file discovery takes place.

1. `kind: "reflexmesh-dataset"`: `id`, `revision`, `populationRef`,
   `dataKind` (`synthetic` or `user-supplied`), one complete legacy
   `DecisionPack`, and `cases: [{id, state}]`. At most 1,000 cases; empty
   cohorts are allowed. This uses the engine's `noul`/`choice`/`score` JSON
   contract, not executable pack definitions. Editing any metadata, case or
   pack changes the canonical SHA-256 dataset digest.
2. `kind: "reflexmesh-labelset"`: `id`, `revision`, `datasetDigest`,
   `independence: "operator-asserted-independent"`, and
   `labels: [{caseId, label: {id, questionId, value, provenance, sourceRef}}]`.
   Provenance is `human` or `test-oracle`; binary values are 0/1, choice values
   are declared class keys and ordinal values are integer rubric indices.
   Labels can be partial, but IDs and case/question pairs cannot repeat.
3. `kind: "reflexmesh-predictions"`: `id`, `datasetDigest`, `deployment`,
   `origin` (`provider-run`, `imported` or `synthetic-fixture`) and `rows`.
   Each row binds `caseId` and `inputDigest` to the full pack and state. An
   `ok` row contains a validated `result`; other rows contain a fixed
   `reasonCode`, never raw provider errors. Imports may omit rows, which
   count as `missing`, not successful negatives.

Each prediction artifact's deployment has its own `id`, `binding` and full
`capabilities`. The binding includes `providerId`, `modelId`, `revision`,
`capabilitiesDigest`, `authorizationRevision`, `toolsetRevision` and
`calibrationRef`. Two sides must have different deployment IDs. Identical
provider/model strings produce `sameModelRoute: true`; this is only a
declared route comparison, not proof of identical model weights or independent
models. Provider aliases can change; explicitly record the evaluated revision.

The runnable synthetic example supplies complete schema examples; do not add
extra fields or infer case identity from deployment-dependent ledger hashes.
Raw original states are deliberately unavailable in the normal ledger, so
this workflow does not silently reconstruct a dataset from it.

### Independence is an operator responsibility

The validator checks structure, identity and binding, **not truth or source
authenticity**. `labelIndependenceVerified` is always false. File origin,
status reasons, provider declarations and `dataKind` are likewise assertions,
not signed attestations. A forged `provider-run` file does not become a live
measurement. Precommit/hold out labels using independent evidence; do not
derive them from the model's answer or treat a lack of incident as a negative
label. Run never reads the label file. An operator can still leak labels by
putting them into dataset state or question instructions; no semantic label
leak detector or automatic prose redactor is provided.

## Explicit, bounded paid runs

Authorize transfer of every selected case's state and the **entire question
contract** before running. Use synthetic/minimized data in a protected local
directory. Provide keys securely through the process environment, not CLI
arguments, files committed to the repository or chat messages.

Required environment:

| Variable | Meaning |
| --- | --- |
| `REFLEXMESH_ALLOW_REMOTE=true` | Explicit provider egress opt-in |
| `REFLEXMESH_PROVIDER` | Exactly `deepseek` or `jev` |
| `REFLEXMESH_PROVIDER_REVISION` | Explicit evaluated adapter/deployment revision |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | Required for DeepSeek |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | Required for Jev |

```bash
npm run evaluation -- run --dataset comparison-lesson/dataset.json --deployment-id candidate-eval-v1 --id candidate-run-1 --out candidate-run-1.json --max-requests 4 --allow-remote --timeout-ms 15000 --max-output-tokens 512
```

If you previewed this exact four-request dataset, add
`--expect-plan-digest SHA256_FROM_THE_FOUR_REQUEST_PLAN` to that command.
The sample is not a real plan digest and cannot be used as one.
If you also supplied `--model-id` and `--provider-revision` to the plan,
prefer `--expect-route-plan-digest SHA256_FROM_ROUTE_PLAN` for the stronger
declared-route mismatch check. Its sample placeholder is not a real digest.

The example's output-token flag is DeepSeek-only. Jev rejects that flag rather
than pretending to enforce it. Both providers require an explicitly selected
account-supported model; there is no fallback or arbitrary endpoint option.
DeepSeek supports binary questions only. An unsupported question anywhere in
the pack makes that case `unsupported`, with zero provider calls; the runner
does not silently remove unsupported questions and compare a different task.

`--max-requests` is a required invocation limit (1–1,000), **not a monetary
ceiling**. Shipped adapters use one HTTP attempt per invocation. Cases are
processed sequentially. The default per-call deadline is 15 seconds; accepted
range is 1–120,000 ms. DeepSeek output tokens default to 512, bounded 1–4,096.
Account prices and actual usage still govern cost. Check the provider account
separately if you need a hard spending limit. Evaluation creates a separate
no-execution/no-tools binding with null calibration; no host profile is loaded.

Every dataset case remains in a runner-produced receipt:

| Status | Fixed reason / interpretation |
| --- | --- |
| `ok` | Valid complete result for this bound model and question set |
| `unsupported` | `input_incompatible`; no invocation for this case |
| `failed` | `provider_error`, `deadline_exceeded` or `cancelled` |
| `not_attempted` | `budget_exhausted`, `stopped_after_failure` or `cancelled` |

A failure, cancellation or timeout stops later provider invocations. Abort
only bounds local waiting; it does not prove the remote request was unreceived,
unbilled or stopped. Late results cannot rewrite the returned receipt. There
are no automatic retries, repair calls, fallback or continuation under another
model. CLI returns 2 when a complete receipt includes a failed row, 1 on command
or persistence errors, 130 on SIGINT, otherwise 0. Inspect status coverage:
exit 0 does not mean every case succeeded (budget and unsupported rows remain).

### Output reservation and crash boundary

Run requires a **new** output file in an existing directory, opened exclusively
before any evaluation. The initial synced marker says
`kind: "reflexmesh-evaluation-incomplete", retryAllowed: false`. An interrupted
or failed write can leave that marker or a partial invalid file. Publication
is not atomic and incomplete files cannot be compared. No artifact is repaired
by resending paid requests. Preserve it and reconcile the remote outcome
before deliberately starting a separately authorized run with a new ID/path.
Using another path does not give cross-run idempotency or a spending guarantee.

Output is also bounded to 4 MiB; large answer sets may exceed that after
requests have completed. Select small cohorts and retain the failure marker;
the runner does not promise recovery of unpersisted answers. Only summaries
appear on run stdout; the prediction file contains model outputs and usage.
Datasets contain raw state and labels may be sensitive. Restrict directory
ACLs (creation mode alone is not a Windows ACL guarantee). Digests are not
anonymization. Do not publish real data or credentials in PRs or issues.

## Read the report

Each question has its own population counts; labels for one question never
substitute for another. The report gives:

- All-case and labeled-case status counts for each side, including missing.
- Each side's available labeled subset metrics, without a direct delta across
  different subsets.
- Paired labeled/both-successful count, both paired metrics and
  **challenger − champion** delta. No paired samples means `null`, not zero.
- All-labeled and paired class balance and declared label-provenance counts.
- Dataset, pack, labelset, deployment and prediction digests and side origins.

Metrics are per question, never averaged across different scales:

- Binary: mean `(probability − label)^2` Brier, equal-width-bin weighted ECE
  and bin counts (the existing calibration implementation).
- Choice: accuracy of the actual returned `choice`, plus multiclass Brier
  **sum** of class squared errors, averaged over cases (not divided by class
  count, nominal range 0–2 for normalized distributions).
- Ordinal: MAE and RMSE of the validated returned `score` against the labeled
  rubric index. The score must agree with its distribution expectation within
  the existing 0.002 tolerance; it is not rounded or converted into a category.

Lower error/ECE is better descriptively; higher accuracy is better. No
confidence interval, statistical significance, threshold sweep, transfer of
calibration or automatic winner is supplied. A tiny synthetic sample validates
the plumbing, not production quality or generalization.

Policy transitions use all cases where **both sides succeeded**, including
unlabeled ones. They show disagreement under the unchanged pack, not measured
false-allow/false-deny rates or actual execution. Reports always declare
`interpretation: "descriptive-only"`, `executionAllowed: false` and
`promotionAllowed: false`.
