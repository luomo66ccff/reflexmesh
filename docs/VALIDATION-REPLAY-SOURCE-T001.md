# Policy replay source-consistency validation — t001

Date: 2026-09-25. Local Windows, synthetic SQLite fixtures and account-free
checks. No real user ledger, model, host tool or profile was accessed.

## Defect and product behavior

Before this change, direct `evidence replay` returned a plausible
original-versus-candidate result after the original stored verdict was changed
or the bound source-pack body was damaged. Black-box tests reproduced that
behavior. The replay CLI now reads the selected completed run and, when the
source-pack table exists, its bounded bound pack inside one read transaction.
It validates the ID/version, row and body digests, event type, question digest,
prediction/model binding and recomputed original verdict before displaying a
comparison. Bad source evidence fails without printing private marker strings.

A deliberately stripped schema-1 fixture has no source-pack table. For
compatibility, replay still works but emits
`originalSourceConsistency: legacy_unverified`; human output shows this
warning before the decision change. Missing source-pack tables in schema 2–4
fail closed. The source-pack export uses the same bounded validation helper,
so the two CLI paths no longer drift on their source consistency rules.

## Local checks

- `npm ci --ignore-scripts`: pass; local npm audit reported zero vulnerabilities.
- Focused replay/template/durable tests: 35/35 pass. Before the correction,
  the new receipt and tamper assertions failed as expected. A final privacy
  assertion that source question instructions stay off stdout passed in a
  focused replay/template rerun (17/17).
- `npm run check`: 936 tests, 934 pass, 0 fail, two local Windows
  symlink-privilege skips; typecheck and build pass. This full run preceded
  the final privacy assertion; exact-head CI covers the submitted version.
- `npm run demo`: pass with synthetic fixtures.
- `git diff --check`: no whitespace errors; Git reports Windows CRLF
  conversion warnings only.

The checks detect local inconsistency, **not cryptographic authenticity**. A
capable writer could alter a ledger and pack consistently. Neither replay
nor export authorizes execution, retry, labels or model quality claims.
Exact-head PR CI and post-merge main CI remain separate evidence gates.
