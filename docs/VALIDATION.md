# Local validation report

Validation date: 2026-09-18.

| Check | Result |
| --- | --- |
| Node.js | v22.16.0 |
| TypeScript | 5.8.3 |
| `npm run typecheck` | Passed |
| `npm test` | 45 passed; 0 failed; 0 skipped |
| `npm run demo` | Passed; mock-only, offline |
| `npm run publish:github -- --dry-run` | Passed; no GitHub writes |
| Real Jev inference | Not run; no authorized API key supplied |
| Remote GitHub repository creation/push | Repository created by the owner; source prepared for publication through the connected GitHub writer |
| GitHub Actions on this repository | Not run; CI definition supplied only |
| Fresh npm dependency download | Not verified: npm registry DNS unavailable in the local execution container |

The installed global compiler was exactly TypeScript 5.8.3, matching the pinned development dependency. Build/typecheck/tests actually ran; this report does not imply `npm ci` successfully contacted the registry. The package-lock integrity was obtained from the official npm registry metadata.

Test coverage includes all three provider primitives, probability mass/label validation, unsafe policy rejection, default shadow mode, explicit authorization, blocked writes, tenant mismatch, in-flight coalescing, conflicting duplicate IDs, bounded capacity, provider/action deadlines, before/after-action audit failures, immutable snapshots, actual tool-argument assessment, JSONL ordering, HTTP contract fixtures, speculation constraints, calibration math and publication argument parsing.

A mocked HTTP transport validates request/response handling, not the actual service, model accuracy or pricing. Mock demo labels are synthetic and must not be presented as benchmark results.

The publication helper's GitHub creation path was not used for this repository; its dry-run and option parsing are tested. The initial source publication is performed through the connected GitHub writer. The helper remains useful for forks or renamed deployments using an authenticated local GitHub CLI.
