# DeepSeek fenced Loader drain integration t001

Date: 2026-09-25. This records publication and CI separately from the
[local validation](VALIDATION-DEEPSEEK-FENCE-T001.md).

- [PR #35](https://github.com/luomo66ccff/reflexmesh/pull/35) merged the
  reviewed head `29e7e797f75c682ae47b0be9932faaf1e8b9e546` into main.
  Its 13 changed files match the local tested tree
  `f8ebad3b6a5effd8f76cec6819b7c3f718476c50`.
- All five checks passed on the
  [exact-head run 36038607851](https://github.com/luomo66ccff/reflexmesh/actions/runs/36038607851):
  Ubuntu/Node 22, Windows/Node 22 and 24, and affected-runtime negative jobs
  on Ubuntu and Windows.
- Main advanced to merge commit `81a00d15c9b8163b7b0700ce470ea6ef6e1e6cf1`.
  Its tree is exactly the reviewed tree above and its parents are the prior
  main `41ac474a7f7c867cece4c6cda0b3c16d540abb13` and reviewed head.
  All five jobs passed again on the
  [main run 36039015452](https://github.com/luomo66ccff/reflexmesh/actions/runs/36039015452).

The local Loader tests exercised an optional drain deadline with pending
callbacks and a real temporary SQLite kernel. Installed DeepSeek Harness
0.1.2-rc.1 regressions used isolated synthetic transport, but did not inject
a permanently hung callback. Neither CI nor those probes certify arbitrary
storage, a blocked event loop, host-tool cancellation, a default user profile,
real-model behavior, or a bug-free release.
