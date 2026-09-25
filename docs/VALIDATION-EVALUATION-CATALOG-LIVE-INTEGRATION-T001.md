# Catalog-gated DeepSeek evaluation: integration readback t001

Date: 2026-09-25. This report records the remote GitHub integration of the
separate [local validation](VALIDATION-EVALUATION-CATALOG-LIVE-T001.md).
Remote CI did not call the account catalog or a model and is not independent
confirmation of the local live results.

## Exact reviewed scope

- GitHub identity for the write: `Amahane-Hikari`.
- [PR #51](https://github.com/luomo66ccff/reflexmesh/pull/51) head:
  `0263f514a562d0c4e65bba5ce86f2c53aa621d8e`; parent:
  `8fe0305a5a5bd66a44e72a4d3ba77d079ce2d638`.
- Reviewed tree: `cab3e06bb45ed9df010e7f2b8d0ed39d83311f66`.
  Remote PR readback contained exactly the 12 intended source, fixed
  synthetic input, test and documentation paths. The private live prediction
  receipts and Harness credential document were not included.
- The five jobs on the [exact PR head](https://github.com/luomo66ccff/reflexmesh/actions/runs/36076633866)
  all concluded `success`: Ubuntu Node 22; Windows Node 22/24; and the
  affected-runtime negative checks on Ubuntu and Windows.
- PR #51 was merged as `e87feffef68ec36320d6e55f455ba4e65a278a01`.
  Its two parents are the former main and the reviewed PR head. Its tree is
  exactly the reviewed tree above; the main ref read back that merge commit.
- The same five jobs on the [exact main merge commit](https://github.com/luomo66ccff/reflexmesh/actions/runs/36077243511)
  all concluded `success`.

## Boundary

This shows the reviewed implementation reached main unchanged and passed the
configured CI matrix. The local account-catalog check and eight paid
completion results are separate, bounded observations. Neither proves
representative quality, calibration, default-profile compatibility, future
model identity/availability, cost or broad host lifecycle behavior. The
earlier failed attempt's remote reception and billing remain unknown. The
long-term product objective remains open.
