# Narrated first-run integration readback t008

Date: 2026-09-25. This records remote publication separately from the
[local behavior and limits](VALIDATION-FIRST-RUN-T007.md).

- [PR #43](https://github.com/luomo66ccff/reflexmesh/pull/43) contained
  six expected files on main parent
  `84a5fc701db23b97a9ec50b4c140fc8cd1ffc389`. The Amahane-Hikari
  head `b185bf4fd70040347762eeecb5d49f33de0fabe4` had tree
  `e830ee3c5d4a27591a0d4bc5675505927f174780`, equal to the local
  staged tree used for verification.
- [Exact-head CI 36055480212](https://github.com/luomo66ccff/reflexmesh/actions/runs/36055480212)
  completed successfully for that head: Ubuntu Node 22, Windows Node 22 and
  Node 24, plus both affected-runtime negative jobs.
- Merge commit `ee80e523ba1bb6b079ba67832e805c7353e808a8` has the prior
  main and tested PR head as parents and the same tree as the PR head.
  [Main CI 36055854135](https://github.com/luomo66ccff/reflexmesh/actions/runs/36055854135)
  completed successfully for that exact merge commit, again with all five
  jobs passing.

This is a publication and regression receipt, not a real-user usability
study, live-host setup, model-quality result, permission grant or
certification that the wider project has no bugs.
