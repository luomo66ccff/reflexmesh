# Authorized isolated DeepSeek real-model validation — t001

Root execution: **2026-09-21T14:38:07.378Z**. Product revision:
`a3dfe39b86b0b4a7480486b4c76e6e60e15eb3b7` (PR #5 baseline).
Windows, Node.js **24.19.0**, installed DeepSeek Harness and official DeepSeek
adapter **0.1.2-rc.1**, Cordis **4.0.2**, Loader **1.0.3**, timer **1.1.4**.

The user explicitly authorized real-model validation with synthetic input and
delegated the bounded configuration choice. This is a real model-driven Agent
tool round trip for one isolated task. It is not a classification benchmark,
a second ReflexMesh DecisionProvider, or default-profile certification.

## Scope and budget

- Official adapter route `deepseek-official`, requested model
  **`deepseek-v4-flash`**, HTTPS endpoint `api.deepseek.com/chat/completions`.
- At most **2 completion requests**, each with at most **512 output tokens**;
  reasoning disabled, text only, no automatic retry or redirect.
- Real fetch was forwarded unchanged behind an endpoint/method/model/body/tool
  budget guard. Responses and streams were not fabricated or replaced.
- Temporary cwd and home, empty-bundle profile, fixed runtime plugins. No user
  profile, conversation, filesystem tool or telemetry plugin was loaded.
- Existing authorized credential was read through the host's pure parser and
  passed only in the child environment. It was not logged, committed, copied
  into generated profile files, or sent in model content. Settings and stored
  credentials were not modified or migrated.
- One tool could return only a newly generated synthetic in-memory value.
  The initial prompt did not contain that value. No production data was sent.
- Requests had a 60-second overall abort budget and 30-second stream-idle
  deadline; the subprocess had an 85-second outer bound and capped output.

## Actual result: passed, 11/11 assertions

Exactly **two real HTTP 200 responses** were observed, and the native Agent
executed exactly one fixture-tool call. Before forwarding request 2, the guard
confirmed it contained the matching tool-call ID and exact tool result. The
real model's final text matched the requested marker plus that returned value.

| Assertion | Verified evidence |
| --- | --- |
| Genuine bounded HTTP | Two forwarded requests, two HTTP 200 responses, no guard rejection |
| Isolated profile loaded | Actual Loader profile tree points at the temporary profile |
| Exactly one native tool | One native ToolRuntime execution with the fixed arguments |
| Actual Agent identity | Tool Agent/session identity and ledger scope digest agree |
| Tool result in real second request | Exact result and tool-call ID in the outbound tool message |
| Final value from real model | Child output equals the marker plus the previously unknown value |
| Selected task receipt | Ready, host-declared, summary-only, within TTL, exact selected-summary digest |
| Shadow/abstain binding | ReflexMesh still observes in shadow with the abstain provider |
| Harness outcome recorded | Exactly one harness-reported succeeded observation |
| Zero labels | No truth/calibration label created from success |
| Cleanup before natural exit | Observer-drained and kernel-closed getters true, with `beforeExit` observed |

The read-only parent ledger handle was closed, and the precisely validated
temporary test directory was removed. The versioned local receipt retained
only fixed metadata, assertion booleans, model ID and status codes; no raw model
responses, credential, conversation or generated challenge was published.
Elapsed time was **1904 ms** for this one probe, not a latency benchmark.
Actual billable tokens/cost were not measured; request limits are not a billing
statement.

## Evidence boundary

This advances the earlier [synthetic Agent validation](VALIDATION-AGENT-LIFECYCLE.md)
without rewriting that historical report. The local runner was a one-off,
reviewed validation harness, not a shipped or CI-enabled model-testing command.
No model request is introduced into ordinary tests, demos or doctor.

Still untested here: arbitrary/default profiles and plugin combinations, native
filesystem/network tool permission behavior, live Linux installation, concurrent
tools, cancellation/restart/subagent lifecycle matrix, Jev inference, provider
quality and an independent second ReflexMesh provider. ReflexMesh remained
abstain-only even though its host used a real model. One passed task does not
establish production security or the absence of bugs.
