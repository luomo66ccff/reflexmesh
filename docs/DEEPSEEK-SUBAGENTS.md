# DeepSeek parent/child task isolation

A parent's selected task summary is **not** the child's selected task summary.
ReflexMesh binds each observation to the live Agent object and its actual
session, not just a tool call ID, a parent pointer, or a shared cancellation
signal. This lets independent agents report on the same tool without silently
borrowing one another's task context.

The opt-in installed-host check is:

```powershell
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode subagent-isolation --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

Only select a trusted installation: the probe executes installed host code.
It uses a temporary profile with an empty bundle list, selected plugins, a
synthetic model adapter and fixed in-memory tools. It does not discover user
profiles, credentials or transcripts. Ordinary offline CI checks the probe
contract, not a locally installed DeepSeek instance.

## Interpreting task coverage

| Agent input | Expected task evidence |
| --- | --- |
| Parent claims a valid, explicitly selected summary | Ready, summary-only receipt scoped to that parent |
| Child has no independently selected summary | Missing, coverage none; no parent-summary inheritance |
| Child claims its own valid, explicitly selected summary | Ready, model-reported receipt with unverified freshness, scoped to that child; parent unchanged |

Missing task evidence is not a broken tool or a denied host permission. It
suppresses ReflexMesh's task-dependent assessment; the host still owns whether
the tool runs. A subsequent tool success remains a harness-reported observation,
not authorization or a correctness label.

In explicit-summary mode, the first text block's first line must start with
`ReflexMesh-Intent: ` and pass the existing size/content checks. The source must
be an actual inbox claim whose producer marks it as user input. For a top-level
Agent that is **host-declared**, not independent human authentication. In particular,
plugin-generated continuation text is not upgraded into a user-selected task
just because it contains the marker. No transcript traversal is added.

The official spawn driver also wraps delegated prompts as `source.kind=user`,
even when the text originated from the parent model. Therefore a live Agent
whose trusted session header has `origin: subagent` or a `parentSession` field
is conservatively treated as **model-reported**. Its envelope has null capture
and expiry timestamps and `freshness: unverified`; the host wrapper cannot
establish when a human authored or confirmed that text. This also conservatively
downgrades genuine human input later sent directly to a child, until a separate
trusted ingress can distinguish it.

Default capture remains off. A private read-time cache TTL, turn and signal checks still apply;
ending or disposing a child must not clear the parent's active selection.
Replacing an Agent with another object carrying the same public ID must not
reuse the original object's in-memory selection.
The private TTL limits local reuse, not independently verified task freshness;
it is not added to the durable model-reported receipt. As for existing
model-reported MCP evidence, the boundary cannot verify the original task's age.

## Evidence limits

`cli_agent_subagent_isolation` is an installed-host check with synthetic model
transport, not real-model inference or complete end-to-end certification.
The [validation report](VALIDATION-DEEPSEEK-SUBAGENTS.md) records the exact
tested host version, source APIs, checks and remaining boundaries. Separately,
the [lifecycle probe](DEEPSEEK-LIFECYCLE.md) covers fixed parallel-tool,
cancellation and task-replacement scenarios.

This mode does not certify arbitrary delegation plugins, real user profiles,
process restart, forced termination, tool-timeout policy or other hosts.
Parent/child IDs separate evidence; they do not authenticate a principal or
grant additional tool permissions. No database migration or historical
observation rewrite is involved.

The source correction only affects newly captured evidence. Existing child
receipts labeled host-declared are not automatically reclassified. Do not use
those old labels as proof of human input. Stop and restart the observer to load
the change; use a new deployment scope if replaying previously observed calls.
