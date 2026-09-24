# Narrated first-run evidence validation t007

Date: 2026-09-25. Scope: local candidate improving the default account-free
first-run experience. Remote review and CI require separate readback.

## Observed user-facing gap

The prior `npm run first-run` succeeded but ended with only three counts:
three decisions, one fixture prediction and zero labels. It did not explain
the product's key distinction between a semantic shadow decision, a later
host-reported result and an independently supplied truth label, or point to
the next safe command. The fuller `npm run demo:evidence` already existed
but required the user to discover it.

## Change and boundary

The default summary now reads values from the same synthetic fixture:
missing task -> no provider call, selected summary -> shadow decision,
duplicate -> replay, missing -> reported fixture host result with zero
labels, and task clear -> no old-summary coverage. It points to the
existing detailed walkthrough or a new-directory retained lesson. The
separate host result remains an observation, not a label; shadow `allow`
does not grant host permission. No provider, tool, profile or network is
opened, and temporary evidence is still removed before success is printed.

## Local checks

- `npm ci --ignore-scripts`: passed; zero reported vulnerabilities.
- `npm run check`: **860 tests, 858 passed, zero failed, two local
  symlink-privilege skips**; typecheck and build passed.
- `npm run first-run`: passed on Node 24.19.0 / SQLite 3.53.3; printed the
  narrated sequence and next step, then reported verified temporary cleanup.
- `npm run demo` and `npm run demo:evidence`: passed. The latter still
  shows the detailed four-stage evidence projection.
- Focused first-run tests cover the JSON transition, default summary,
  retained summary, npm path forwarding, cleanup failure and no-overwrite
  behavior. The direct `node --test` run skipped only the npm-env-specific
  test; the full npm check ran it.

This is not a real-user usability study, live-host setup, model-quality
measurement or proof that the wider project has no bugs.
