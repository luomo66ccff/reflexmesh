# Independent DeepSeek decision provider

`DeepSeekEstimateProvider` is ReflexMesh's second, independent decision
provider. It sends a bounded JSON request to the fixed
`https://api.deepseek.com/chat/completions` endpoint; it does not call Jev or
reuse Jev credentials, transport or response parsing. This is **shadow
assessment**, not a DeepSeek Harness integration, tool executor or host
permission system. Read the [capability contract](PROVIDER-CONFORMANCE.md)
before attaching it to a host.

## What the numbers mean

The provider's versioned `binary-json-estimate-v1` contract accepts current
`noul` (binary) questions only. The model returns its own numeric estimate in
`[0,1]`; ReflexMesh records it as
`probabilitySemantics: 'elicited-estimate'`. This is **not** a measured token probability,
independent fact, calibrated confidence or authorization. The built-in policy
thresholds are demonstrations, not model-specific safety thresholds. `choice`
and `score` questions are declared unsupported and escalate with **zero remote
requests**; there is no invented distribution, confidence, answer repair or
fallback to Jev. A malformed, partial or wrong-model response also fails
closed without a retry.

The declaration currently limits the final state to 16,000 UTF-8 JSON bytes
and at most 16 questions. The provider also applies a 32,000-byte complete
request limit, a 131,072-byte default response limit and a default output
budget of 512 tokens. These are implementation bounds, not guarantees of
vendor billing or network completion. It makes one HTTPS attempt per selected
evaluation, rejects redirects and does not log the raw response body on
failure. A timeout or lost response does not prove that the remote service
never received the request.

## Account-free inspection, then explicit one-request example

Use a Node runtime meeting the [SQLite WAL write requirement](SQLITE-RUNTIME.md)
(the 22.16+ API floor alone is insufficient) and build locally.
The first command only prints help after
the build; it does not discover a profile, read a key, create a ledger or make a
remote request:

```powershell
npm ci --ignore-scripts
npm run demo:deepseek
```

Only if you have independently approved sending the **synthetic** fixed state
and questions to DeepSeek, set the four explicit variables in a private local
environment. Supply `DEEPSEEK_API_KEY` through your protected secret mechanism;
do not paste it into a tracked file, command transcript or issue. For the
explicitly selected `deepseek-flash` model, a PowerShell session can set the
non-secret switches as follows:

```powershell
$env:REFLEXMESH_ALLOW_REMOTE = 'true'
$env:DEEPSEEK_MODEL = 'deepseek-flash'
$env:REFLEXMESH_PROVIDER_REVISION = 'binary-json-estimate-v1'
# DEEPSEEK_API_KEY must already be present in this private process environment.
npm run demo:deepseek -- --execute
```

`--execute` is the only mode that invokes the provider. It permits at most one
paid model request behind an additional 8,000-byte demo request guard, with
synthetic state/arguments only; no host tool
executes and no labels are generated. Its temporary local SQLite ledger is
closed and removed after checking an exact result, a no-request replay after
reopen, a no-request unsupported-choice refusal and policy-only replay. Check
the JSON `status`, `assertions`, `requests` and `transport`; a failed status is
not a pass. An injected transport in tests is not real inference. The
[dated independent-provider validation](VALIDATION-INDEPENDENT-PROVIDER-T001.md)
records the narrow authorized live run separately, without turning one model
response into calibration or host certification.

## Opt-in host factory and current Loader boundary

The existing `openLocalBoundary` factory selects this provider only with the
first five explicit values below. Set a private database and new scope as well
for a separately named shadow deployment:

```text
REFLEXMESH_PROVIDER=deepseek
REFLEXMESH_ALLOW_REMOTE=true
DEEPSEEK_API_KEY=<private local secret>
DEEPSEEK_MODEL=<explicit model ID>
REFLEXMESH_PROVIDER_REVISION=<explicit deployment/contract revision>
REFLEXMESH_DB=<private local SQLite path; recommended isolation>
REFLEXMESH_SCOPE=<new shadow deployment scope; recommended isolation>
```

The factory remains **shadow only**. `REFLEXMESH_TASK_EVIDENCE=true` opts into
the task-aware boundary; missing, stale or withheld task evidence suppresses
provider assessment rather than substituting a guessed user intent. Selected
state and questions, including any explicitly admitted task summary, can be
sent to the remote provider, so review privacy and egress authorization before
enabling it. Keep the ledger on a private **local** filesystem. The factory's
host-facing decision deadline is 3 seconds; the standalone example allows 15
seconds. Passing the example does not establish that a host call will complete
within the shorter boundary.

The shipped DeepSeek CLI/profile Loader plugin **still creates an abstaining
observer**. Setting these environment variables does not change its provider
or enable model inference there; wiring a trusted custom boundary is a
separate integration step. The observer continues to delegate host permission
and tool execution decisions to DeepSeek. This provider never grants a host
tool permission, retries an unknown action or creates ground-truth labels from
reported outcomes. See the [Loader guide](DEEPSEEK-AGENT.md) and
[host observer guide](DEEPSEEK-HOST.md) for those distinct surfaces.

## Upgrade and evidence boundary

Before replacing an older Jev/abstain deployment or a binary predating
capability binding, stop its workers and make a SQLite-consistent backup; do
not run old and new writers together or copy only the main DB file while WAL
writers are active. Use a new `REFLEXMESH_SCOPE` (or a separate private DB) for
new shadow observations. Keep old rows for inspection, and reconcile uncertain
host actions before any new call. A new scope is **not** permission to resend a
tool request or retry an UNKNOWN execution.

The SQLite schema remains version 3. New decision identities bind the provider
ID, explicit model/revision and canonical capability digest. Reusing an old
same-key identity with a new binding conflicts; there is no legacy bypass,
silent threshold reuse or automatic data migration. Existing schema-1/2/3
evidence stays readable, but absent capability fields appear as `null` rather
than being backfilled or retroactively certified. Inspect a record with:

```powershell
npm run evidence -- inspect --db <private-local-ledger> --key <decision-key>
```

The public projection shows `providerCapabilities.digest` and
`providerCapabilities.probabilitySemantics`; they describe the recorded
declaration, not a calibrated model or verified execution. No automated
champion/challenger comparison, automatic calibration, label-only pack, model
alias stability guarantee or production security certification is included.
