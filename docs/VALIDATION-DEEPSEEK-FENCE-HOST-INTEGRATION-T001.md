# Installed DeepSeek fence-probe integration readback t001

Date: 2026-09-25. This records remote integration separately from the
[local installed-host receipt](VALIDATION-DEEPSEEK-FENCE-HOST-T001.md).

- [PR #37](https://github.com/luomo66ccff/reflexmesh/pull/37) proposed ten
  files on main parent `516f186a71a691b10954c0664c4bd5b287cacd42`.
  The Amahane-Hikari-authored head
  `5ed6ee90a1fb40130c12dc0c19aa96f22b4f3fc5` had tree
  `6b4bbbf63d14580701c2b9d093674c78eeb77ed7`, exactly matching the
  locally staged and checked tree.
- [Exact-head CI 36043066525](https://github.com/luomo66ccff/reflexmesh/actions/runs/36043066525)
  completed successfully for that head: Ubuntu Node 22, Windows Node 22 and
  Node 24, and both affected-runtime negative jobs passed.
- The merge commit `fc29c519dae4aa4edc6e18c2006423fa049d6b3a` has the
  previous main and tested PR head as parents, and the same tree as that
  head. [Main CI 36043751219](https://github.com/luomo66ccff/reflexmesh/actions/runs/36043751219)
  completed successfully for the exact merge commit with all five jobs
  passing.

This is an integration and regression receipt, not independent proof that
arbitrary callbacks or tools can be cancelled, that model inference ran, or
that default-profile production behavior is supported. The installed-host
scenario and its limits remain as stated in the local receipt.
