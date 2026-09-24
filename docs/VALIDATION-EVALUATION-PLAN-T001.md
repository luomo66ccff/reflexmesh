# Offline evaluation plan validation t001

Date: 2026-09-25. Scope: a local candidate for a credential-free preview
before a separately authorized, potentially paid provider comparison run.
Remote PR review and CI require separate readback.

## Behavior and boundary

`evaluation plan` reads one explicit dataset file and the trusted, versioned
Jev or DeepSeek capability declaration. It applies the same
`assertProviderInput` gate as the runner to every case, then reports how many
are compatible, unsupported, and at most selected under a request cap. The
selected canonical `{state, questions}` byte total is metadata, **not** the
actual HTTP body size or a privacy guarantee. The plan prints no state,
question text, case IDs, credential, label or model answer. It does not
construct a provider, open a host profile, call a model, create an output
artifact or read a label file.

DeepSeek remains binary-question-only; a mixed binary/choice pack is fully
incompatible with that provider. Jev's existing capability declaration is
now exported once and reused by both the provider and plan, so the preview
does not maintain a second copy of its limits. A failed or cancelled run may
make fewer requests than the previewed upper bound. Endpoint availability,
model revision, wire overhead, response validity, actual cost and quality are
not checked. A dataset can itself contain sensitive data or leaked labels;
the plan is not a semantic scanner. No money ceiling or permission to send
the dataset is implied.

## Local checks

- `npm ci --ignore-scripts`: passed with zero reported vulnerabilities.
- `npm run check`: **858 tests, 856 passed, zero failed, two local
  symlink-privilege skips**; typecheck and build passed.
- `npm run demo`, `npm run demo:durable`, `npm run demo:recovery` and
  `npm run demo:comparison`: passed.
- Focused CLI tests exercised the preview with a credential-access trap and
  network trap; verified no input-file mutation or raw state in output,
  request-cap accounting, large-state incompatibility, and differing
  binary/choice support for DeepSeek and Jev. Invalid options and a forbidden
  label/remote flag fail before work.

No real provider account, key, user dataset, paid request or host tool was
used. The prior installed-host validation remains a separate, unchanged
receipt.
