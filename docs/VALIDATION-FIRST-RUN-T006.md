# Windows hook-fixture CI follow-up t006

Date: 2026-09-24. Scope: failure and bounded test-only repair following
[first-run integration t005](VALIDATION-FIRST-RUN-T005.md).

## Failure and fix

- After documentation-only [PR #24](https://github.com/luomo66ccff/reflexmesh/pull/24)
  merged, [main CI 36008198413](https://github.com/luomo66ccff/reflexmesh/actions/runs/36008198413)
  failed its Windows Node 22 `npm run check` job: 817 tests, 813 passed,
  three failed and one existing symlink skip. Tests #246–248 in
  `claude-outcome-pairing.test.mjs` each received child `status: null` at
  the fixture's five-second `spawnSync` deadline. The other four jobs passed.
  The exact reason the child exceeded that limit was not proved.
- [PR #25](https://github.com/luomo66ccff/reflexmesh/pull/25) changed only
  that test file. The correctness fixture now has a bounded 20-second child
  deadline and checks `child.error` before exit status, so a future timeout
  is directly visible. Production hooks, runtime policy and CI workflow were
  not changed.
- Local Windows Node 24: focused pairing suite 15/15 passed; full
  `npm run check` had 817 tests, 815 passed, zero failed and two local
  symlink skips.
- [Exact-head PR CI 36009614394](https://github.com/luomo66ccff/reflexmesh/actions/runs/36009614394)
  passed all five jobs. Windows Node 22 had 817 tests, 816 passed, zero
  failed and one existing symlink skip.
- Amahane-Hikari merged PR #25 into main as
  `f0548fdc92cdb59800c8d5ae88384df4e18e416d`. Its tree
  `c3f1de040e29208232d7f5aefeb707aa52c917fe` matches the reviewed head.
  [Post-merge main CI 36010120753](https://github.com/luomo66ccff/reflexmesh/actions/runs/36010120753)
  passed all five jobs against that exact merge commit.

## Boundary

The failure is consistent with transient slow startup or SQLite initialization
on a loaded runner, but the logs do not identify a single cause. Extending a
test-only deadline does not establish production hook latency, real-user host
compatibility, or absence of other bugs. The unrelated local working branch
was not reset or pushed.
