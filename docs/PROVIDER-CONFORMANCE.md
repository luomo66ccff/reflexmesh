# Provider capability and conformance design

Status: **design only**. The current runtime still exposes the original
`DecisionProvider` interface and Jev remains the only non-fixture provider.
Nothing in this document enables provider fallback, migrates a deployment, or
certifies a model as calibrated.

## Capability contract

The next provider API revision should add one immutable, runtime-validated
declaration to every provider:

```ts
interface ProviderCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly resultContract: 'probabilistic-v1' | 'label-only-v1';
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

All limits are positive safe integers. Unknown keys, unknown enum values,
contradictory declarations and missing declarations fail construction. The
runtime snapshots and deeply freezes a valid declaration. Wrappers such as
`TaskAwareBoundary` and `DurableMesh` must propagate that exact validated
snapshot; recreating only `{ id, evaluate }` is not sufficient.

`probability` and `distribution` mean that the provider natively returns those
numeric fields. The current choice and score result contract also requires a
native confidence field, and a score must equal the distribution's expected
value within the validator tolerance. A provider that lacks confidence is not
compatible merely because it returns a distribution; a conversion needs its
own explicit, versioned result contract. None of these declarations mean that
the values are independently calibrated. Calibration remains deployment
evidence identified by an explicit provider/model/revision/pack tuple, sample
population and evaluation revision. `label-only` must never be expanded into
one-hot vectors, arbitrary confidence values or synthetic probabilities.

## Compatibility gate

Before calling a provider, the runtime derives requirements from the immutable
pack and validates them against the provider declaration. Immediately before
egress it also rechecks the final state UTF-8 byte size, question count,
per-question choice count, cancellation signal and supported answer types.

An unknown or incompatible declaration produces an escalation and **zero**
provider calls. There is no automatic provider fallback. A provider/model or
capability revision change requires a separately named deployment binding and
cannot inherit thresholds, labels or calibration claims from an older binding.
The validated capability snapshot is canonically hashed; that digest joins the
existing provider ID, model ID and provider revision in the deployment binding,
durable evidence and idempotency request identity.

The existing `ProviderResult` and packs are `probabilistic-v1`: `noul` needs a
native probability and `choice`/`score` need complete distributions. Until an
explicit `label-only-v1` result and pack schema is implemented atomically, a
label-only provider is incompatible with every current pack and must be
rejected before evaluation. A future label-only pack may use categorical value
rules only; it cannot use confidence or probability thresholds.

## Independent provider milestone

The second implementation must not call Jev internally or share Jev transport,
credentials or response parsing. Its first release supports only the answer
types it actually produces and declares all others unsupported. If it exposes
model score distributions, they are described as uncalibrated estimates until
a separate labeled evaluation establishes otherwise. If it only exposes
labels, the label-only result/pack schema must land in the same milestone.

The minimum conformance suite is provider-neutral and runs unchanged against
Jev's offline transport fixture and the independent implementation:

- supported question/result round trip with exact label sets;
- required confidence fields and score/distribution expectation consistency;
- unsupported question type rejected before provider invocation;
- final state, question and choice limits rechecked before invocation;
- malformed, partial, non-finite and mismatched results rejected;
- cancellation before and during evaluation, with no retry;
- provider/model/revision/capability mismatch rejected without threshold reuse;
- wrapper propagation through task-aware and durable paths;
- no fallback call when the selected provider fails.

Champion/challenger comparison is a later evaluation workflow. It must use
separately named bindings and independent labels; a host outcome, approval or
absence of an incident is not automatically a truth label.
