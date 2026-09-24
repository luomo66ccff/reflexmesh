# First-run integration validation t005

Date: 2026-09-24. Scope: publication and post-merge verification of the
retained-evidence first-run lesson and the [t004 cleanup fix](VALIDATION-FIRST-RUN-T004.md).

## Reviewed publication

- [PR #23](https://github.com/luomo66ccff/reflexmesh/pull/23) was reviewed
  against main. Review found that the original CLI could claim temporary
  deletion before cleanup and could swallow cleanup failures. The fix defers
  the success receipt until verified cleanup and adds deterministic failure
  regressions for default and retained-lesson paths.
- The review fix was added without forcing the feature branch. Final PR head
  `622a0d9ce20daca06c8475e8831372e2800b65b4` had tree
  `676fb46103608cdf3a2bcb749a1a03c3a6e73211`.
- [Exact-head PR CI 36005685879](https://github.com/luomo66ccff/reflexmesh/actions/runs/36005685879)
  completed successfully in all five jobs: Ubuntu Node 22, Windows Node 22
  and 24, and Ubuntu/Windows affected-runtime negative checks. Each test job
  ran the first-run command. The separate local test evidence remains in t004.
- Amahane-Hikari merged the PR at `81d6286ffa3f9fab2cd58c06d6cfe4903112d835`.
  Its parents are prior main `ccbd348d44b4247313cb1edefe531546a9d2cf39`
  and the reviewed PR head; its tree is the same reviewed `676fb461...` tree.
  The source branch was retained.
- [Post-merge main CI 36006377573](https://github.com/luomo66ccff/reflexmesh/actions/runs/36006377573)
  completed successfully in all five jobs against the exact merge commit,
  including `npm run first-run` on all three test jobs.

## Boundary

This is an account-free synthetic lesson and publication check. It does not
prove unattended cleanup after process kill, a real user's first-run journey,
default-profile compatibility, real-model quality, or absence of every bug.
The local working branch with unrelated in-progress changes was not staged,
reset or pushed as part of this PR.
