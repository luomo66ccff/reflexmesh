# Catalog-gated DeepSeek evaluation: local validation t001

Date: 2026-09-25. Scope: current local candidate, an opt-in account model
catalog gate for the shipped DeepSeek evaluation CLI and one bounded live
synthetic run. This is not remote PR/main CI evidence, a representative model
benchmark or a default Harness profile change.

## Why this increment

Eight fixed synthetic task/action cases were written with four positive and
four negative `test-oracle` labels before model output was inspected. The
dataset has one binary intent-and-scope question. It contains no user data,
real host action, account secret or truth inferred from the model. Dataset
validation accepted eight cases and eight labels, with digest
`f20341805efc19a32dd2006857c392e336719283c81331d249027b07ff7972cf`.
The offline route plan reported eight capability-compatible and eight
wire-sendable cases under an eight-request, 128-output-token cap. It estimated
no monetary cost and did not read credentials or labels.

The installed Harness default still named `deepseek-v4-flash`. The first
guarded live evaluation under that declared route persisted one
`provider_error` and seven `stopped_after_failure` rows; the CLI made no
automatic retry. Its fixed receipt does not reveal the HTTP/parse failure
stage, and whether the remote provider received or billed that attempt is
unknown. The complete failure artifact remains in the private local evidence
directory. No conclusion that the legacy alias itself caused this failure is
supported by that receipt.

A separate read-only authenticated `GET /models` returned HTTP 200 and the
account-listed IDs `deepseek-flash` and `deepseek-v4-pro`. The official
[model-list API](https://api-docs.deepseek.com/api/list-models/) defines this
as the current available-model catalog. The official
[change log](https://api-docs.deepseek.com/updates/) also says the old Flash
name may remain a compatibility alias; catalog absence is not proof that an
alias cannot be accepted. An old host default should therefore not silently
become the evaluation route.

## Change and verification

- `run --require-listed-model` is DeepSeek-only and requires an already
  matching route or wire guard. It checks explicit remote opt-in first, then
  makes one authenticated, bounded, no-redirect catalog GET with the key that
  will be passed to the provider. An unlisted ID, failed request or invalid
  response fails before provider construction, output reservation or any
  completion request. This GET is outside the completion request cap.
- The gate uses a 10-second abort budget and 64 KiB UTF-8 response bound. It
  never logs the key, catalog body or a remote error body. It does not prove
  backend weight identity, future availability, adequate balance or billing.
- The real account rejected a guarded `deepseek-v4-flash` route with the fixed
  unlisted-model message and no output file. This was a catalog GET only; it
  did not resend the failed completion.
- A deliberately separate, newly named evaluation using the listed
  `deepseek-flash` route, the same precommitted synthetic dataset, all three
  plan guards and the catalog gate persisted **8 ok, 0 failed, 0 unsupported,
  0 not attempted** rows. It reported zero tool executions and no automatic
  retry. API usage included in the validated results totals **2445 input**
  and **144 output** tokens across eight completion requests. Actual invoice
  cost was not checked; the first failed attempt may have been billed.
- The repository's validators accepted the dataset, labels and prediction
  artifact. Its `calibrationReport` on the eight labeled outputs gave Brier
  **0.0012** and 10-bin ECE **0.03**, with four positive and four negative
  fixture targets. These values describe only this intentionally easy
  synthetic slice; label independence is operator-asserted, not verified.
- `npm ci --ignore-scripts` passed with zero reported vulnerabilities.
  Final `npm run check` passed **874/876** tests, zero failures and two local Windows
  symlink-privilege skips; typecheck/build passed. `npm run demo` passed.
  Focused catalog/CLI/fixture tests passed **23/23**.

## Boundaries and artifacts

The source dataset and labels are `examples/evaluation-intent-scope-t001.json`
and `examples/evaluation-intent-scope-labels-t001.json`. The complete failed
and successful prediction receipts are retained in the separate local
`reflexmesh-eval-evidence-t001` directory and are not published to GitHub.
The credential was read only into the local child process environment from
the existing Harness credential document; no profile, setting or credential
file was modified or copied into the repository. Neither the model nor this
gate authorized or executed a host tool.

This small result does not establish real-user usefulness, broad model
accuracy/calibration, Jev comparison, default-profile compatibility,
concurrent host behavior or the absence of bugs. The product goal remains
open.
