# Provider capabilities and conformance

Status: **implemented in this alpha**, with bounded offline conformance tests and a
separate, narrow [independent-provider live validation](VALIDATION-INDEPENDENT-PROVIDER-T001.md).
This is not calibration, a provider fallback policy, or production authorization.
The older [DeepSeek host/model transport check](VALIDATION-DEEPSEEK-REAL-MODEL-T001.md)
tested a different integration and must not be counted as this provider's validation.

## The declared contract

Every `DecisionProvider` now requires a trusted, immutable declaration. The
runtime validates closed JSON keys/enums and positive safe-integer limits,
copies the declaration, and deeply freezes the copy. A missing, malformed or
contradictory declaration rejects construction; it cannot be supplied by an
event, model response or host tool payload.

```ts
interface ProviderCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly resultContract: 'probabilistic-v1' | 'label-only-v1';
  readonly probabilitySemantics:
    | 'provider-native' | 'elicited-estimate' | 'synthetic-fixture' | 'none';
  readonly answers: {
    readonly noul: 'probability' | 'unsupported';
    readonly choice: 'distribution-with-confidence' | 'label-only' | 'unsupported';
    readonly score: 'distribution-with-confidence-and-expected-value' | 'unsupported';
  };
  readonly limits: {
    readonly maxStateBytes: number;
    readonly maxQuestions: number;
    readonly maxChoicesPerQuestion: number;
  };
}
```

`provider-native` describes numeric fields returned by the selected provider,
**not** independent calibration. `elicited-estimate` means a model authored a
numeric estimate in a constrained response; it is neither a token-logprob
measurement nor a calibrated probability. `synthetic-fixture` is test data, and
`none` is used by the explicit all-unsupported abstention provider. No current
result gains confidence or a distribution by filling in absent fields.

| Registered provider | Declared result support | Probability semantics |
| --- | --- | --- |
| Jev | `noul`, `choice`, `score` under `probabilistic-v1` | `provider-native` |
| `DeepSeekEstimateProvider` | `noul` only; `choice` and `score` unsupported | `elicited-estimate` |
| `MockProvider` | Fixture answers for all three current types | `synthetic-fixture` |
| Default abstain | All answer types unsupported; no evaluation | `none` |

The `label-only-v1` declaration is representable, but no matching result/pack
path ships. It is rejected by the current evaluation gate. Current packs and
`ProviderResult` require `probabilistic-v1`: `noul` has one number, while
`choice` and `score` require complete declared-label distributions plus
confidence; a score must match its distribution's expected value within the
validator tolerance. A label-only answer is never turned into a one-hot vector
or invented confidence.

## Gates, wrappers and binding

`snapshotProvider` captures the provider ID, any explicit model, validated
capabilities and bound evaluation method. Runtime and task/durable wrappers
preserve that snapshot. Immediately before evaluation, `assertProviderInput`
checks the final JSON state **and questions** (including serialization hooks),
UTF-8 state byte count, question and choice counts, supported types and the
cancellation signal. Jev and DeepSeek also repeat the gate before HTTP egress;
each keeps its own request/response size and parser limits. Within a ReflexMesh
run, unsupported inputs escalate with **zero provider calls**; a direct
`provider.evaluate` call rejects. There is no fallback or automatic retry.
Failure after an attempted remote request is not proof that it never arrived.

`normalizeProviderBinding` adds the SHA-256 digest of the canonical validated
capability snapshot to `binding.capabilitiesDigest`, alongside the existing
provider ID, model ID and explicit provider revision. A supplied different
digest, or an explicit provider model differing from the binding, is rejected
before durable admission. The same normalized binding is used for Shadow's
Claude deployment digest and DurableMesh's request identity; an old same-key
identity conflicts rather than silently inheriting a new provider or threshold.
Durable evidence retains the validated capability snapshot; the read-only
evidence projection exposes its digest and probability semantics. Historical
schema-1/2/3 rows remain readable with `null` for absent fields. Schema 3 is
unchanged: there is no backfill or fabricated capability claim for old rows.

Changing provider, model, prompt/contract revision or capability declaration
requires a new, explicitly named shadow deployment namespace and independent
calibration review. Stop old workers and make a SQLite-consistent backup before
upgrading; mixed old/new workers are unsupported. A new namespace never
authorizes retrying an uncertain host action. See the
[DeepSeek provider guide](DEEPSEEK-PROVIDER.md) and [recovery boundaries](RECOVERY.md).

## Conformance scope and remaining work

The offline suites `test/provider-capabilities.test.mjs`,
`test/provider-conformance.test.mjs` and `test/deepseek-provider.test.mjs`
exercise strict declarations, exact answer sets, missing/malformed/non-finite
results, unsupported types and final input limits before egress, cancellation,
model and capability mismatch, wrapper propagation and no fallback. Jev uses
an injected offline transport; DeepSeek's transport is independent and does
not call Jev. The separate live validation records one explicitly authorized
remote inference using synthetic data; it does not certify all models, aliases,
host lifecycles or future vendor behavior.

Calibration still needs separately obtained labels, a specified population,
model/provider/pack/revision identity and an evaluation revision. Host outcomes,
permissions and incident-free runs are not automatically truth labels.
Champion/challenger comparison, label-only packs and automatic provider
migration remain future work.
