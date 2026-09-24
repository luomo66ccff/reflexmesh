# Offline evaluation plan integration readback t001

Date: 2026-09-25. This records remote publication separately from the
[local behavior and limits](VALIDATION-EVALUATION-PLAN-T001.md).

- [PR #39](https://github.com/luomo66ccff/reflexmesh/pull/39) contained nine
  expected files on main parent
  `f6627b1734a0a88fcf062c9fa8dc62f248ed2dfa`. The Amahane-Hikari
  head `f184a1312a4b4c846c6a39e7bd6b594ef8512fdf` had tree
  `682f816626cc101617e2f3e65bdb022b51c93546`, equal to the local
  staged tree used for verification.
- [Exact-head CI 36048069201](https://github.com/luomo66ccff/reflexmesh/actions/runs/36048069201)
  completed successfully for that head: Ubuntu Node 22, Windows Node 22 and
  Node 24, plus both affected-runtime negative jobs.
- Merge commit `700cf132426207fc5de1b93456851def3155654d` has the prior
  main and tested PR head as parents and the same tree as the PR head.
  [Main CI 36048851731](https://github.com/luomo66ccff/reflexmesh/actions/runs/36048851731)
  completed successfully for that exact merge commit, again with all five
  jobs passing.

This is a publication and regression receipt. Neither CI run exercised a
paid provider, authenticated the dataset's labels, proved a model's quality,
bounded account spending, or certified arbitrary data as safe to send.
