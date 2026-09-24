# Offline evaluation plan guard integration readback t001

Date: 2026-09-25. This records remote publication separately from the
[local behavior and limits](VALIDATION-EVALUATION-PLAN-GUARD-T001.md).

- [PR #41](https://github.com/luomo66ccff/reflexmesh/pull/41) contained
  eight expected files on main parent
  `85af4926405df367df7e72a7e5535d232cb0ba4c`. The Amahane-Hikari
  head `2a10ef1119b1fd822ca713ec94c69fd4fe9f67e0` had tree
  `ffa4d5582b9cfd535c78ee54b2a1121cf3dab3d5`, equal to the local
  staged tree used for verification.
- [Exact-head CI 36052609169](https://github.com/luomo66ccff/reflexmesh/actions/runs/36052609169)
  completed successfully for that head: Ubuntu Node 22, Windows Node 22 and
  Node 24, plus both affected-runtime negative jobs.
- Merge commit `b8b5258c828b442c9cef3b59bb87361688af2b8a` has the prior
  main and tested PR head as parents and the same tree as the PR head.
  [Main CI 36052996575](https://github.com/luomo66ccff/reflexmesh/actions/runs/36052996575)
  completed successfully for that exact merge commit, again with all five
  jobs passing.

This is a publication and regression receipt. Neither CI run exercised a
paid provider, authenticated a user's dataset review, proved a model route,
bounded account spending, or certified arbitrary data as safe to send.
