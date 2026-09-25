# Offline evidence story — local validation t001

Date: 2026-09-25. Scope: one bounded local evidence projection, the retained synthetic first-run lesson, and explicit new-file export. This is not a live dashboard or a real-host/model acceptance run.

## Product behavior

- `npm run first-run -- --out-dir NEW_DIRECTORY` passed on Windows Node 24.19.0 / SQLite 3.53.3. It retained `EVIDENCE-STORY.html` alongside the synthetic ledger, candidate and guide. The summary reported 3 decisions, 1 fixture prediction, 0 labels, and the separate missing → succeeded test-oracle observation. No model, host tool, profile or provider ran.
- `evidence story --db PATH --key KEY --out NEW_FILE` reads one bounded `evidenceSnapshot`, writes a restrictive new local file and verifies byte-for-byte readback. It refuses an existing destination and an unknown key. The command does not change ledger records, invoke a model/tool, or grant execution authority. Read-only SQLite can still interact with WAL/SHM sidecars.
- The renderer escapes dynamic metadata, has no JavaScript, images or external assets, and includes a restrictive content-security policy. UNKNOWN and ambiguous/missing reports are visually marked for review; operator conclusions never imply retry permission.

## Checks performed

- `npm ci --ignore-scripts`: passed; 0 npm audit vulnerabilities at this check.
- `npm run check`: 972 tests, 970 passed, 0 failed, 2 skipped for local Windows symlink privilege. Includes new renderer, new-only export, privacy, first-run and CLI tests. A later one-line unknown-key diagnostic refinement was covered by rerunning focused tests.
- `npm run demo`: passed; existing workflow output remains synthetic/shadow as documented.
- Generated a fresh private synthetic retained lesson and inspected the HTML in installed Microsoft Edge via Playwright CLI. Direct `file://` navigation was blocked by the browser automation tool, so the exact generated file was served only from a temporary `127.0.0.1` HTTP process; that process and browser were closed after checking. Desktop (1280 px) and narrow (390 px) screenshots were visually reviewed. At 390 px, document scroll width equaled viewport width; there were 0 script elements, 0 link/image/iframe elements, and the browser request list contained only the loopback document request. The accessible DOM snapshot showed the four separate evidence columns and all six sections.
- The test asserts the retained HTML excludes both the selected raw task summary and an unselected private body marker. The real-ledger export path was exercised against the synthetic ledger only, never personal deployment data.

## Boundaries

Browser automation did not verify opening by double-clicking the `file://` artifact because that protocol was blocked by the tool. The page's source is self-contained, but a separate file-protocol acceptance check remains worthwhile. CSP and escaping reduce HTML injection risk; they do not make local metadata anonymous or authenticate a tamperable ledger. This work does not address default-profile onboarding, representative independent-model quality, broad host cancellation, or the long-term bug-free objective.
