# Single-side evaluation score: integration readback t001

Date: 2026-09-25. This records GitHub integration of the separate
[local validation](VALIDATION-EVALUATION-SINGLE-SIDE-SCORE-T001.md).
Remote CI did not call DeepSeek, read the retained private prediction receipts
or independently validate the earlier live run.

## Exact reviewed scope

- GitHub write identity: `Amahane-Hikari`.
- [PR #53](https://github.com/luomo66ccff/reflexmesh/pull/53) head:
  `20d7bc1e7a3f242ed7172081d080c5b43a51dbd2`; parent:
  `a9bb34a00c466be5ba9b9096656db804a0e090a4`.
- Reviewed tree: `6f07e0d01c3002b1029d0c894cb112d1e313f250`. Remote PR
  readback contained exactly nine intended source, test and documentation
  paths. No private prediction receipt or credential document was published.
- All five jobs on the [exact PR head](https://github.com/luomo66ccff/reflexmesh/actions/runs/36079755049)
  concluded `success`: Ubuntu Node 22; Windows Node 22/24; and the
  affected-runtime negative checks on Ubuntu and Windows.
- PR #53 merged as `0828d7607618654e924b2e971955af9650794e51`.
  Its two parents are the former main and the reviewed PR head; its tree is
  exactly the reviewed tree. The main ref read back this merge commit.
- The same five jobs on the [exact main merge commit](https://github.com/luomo66ccff/reflexmesh/actions/runs/36080234783)
  all concluded `success`.

## Boundary

This demonstrates unchanged integration and the configured CI matrix, not
representative prediction quality, calibration, label independence, verified
model origin, default-profile support or broad host acceptance. The local
eight-case synthetic success and zero-scored failure remain separate bounded
observations; the earlier failed request's remote reception and billing are
still unknown. The long-term product objective remains open.
