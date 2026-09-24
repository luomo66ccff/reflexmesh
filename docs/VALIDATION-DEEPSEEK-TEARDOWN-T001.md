# Installed DeepSeek observer teardown validation t001

Date: 2026-09-25. Scope: an opt-in, installed DeepSeek Harness 0.1.2-rc.1
CLI/Loader/Agent/ToolRuntime probe with an isolated temporary profile, a
synthetic model adapter and one fixed in-memory tool. This is local evidence,
not PR CI, default-profile acceptance or real-model inference.

## Reproduce

Use only a trusted installed host package root; this command executes its code.
It needs no account or model key and does not inherit the user's DeepSeek
profile. Its temporary home, profile, cwd and SQLite ledger are removed after
the bounded child process exits.

```powershell
npm run build
node scripts/real-host-compat.mjs --host deepseek --deepseek-mode observer-teardown --deepseek-package-root 'D:\DeepSeekHarness\app\node_modules\@deepseek-ai\dsh'
```

The fixed task asks the synthetic Agent to call one native tool. The tool body
starts, then waits while the fixture disables **only** the ReflexMesh observer
through the host's official Loader. Its `shutdownResultWaitMs: 0` budget makes
the accepted call's still-absent `tools/result` expire at observer disposal.
Only after Loader disposal and kernel closure does the fixture release the
tool body. The host emits a late successful `tools/result` and the Agent
returns a fixed marker before Headless exits naturally.

## Observed local result

- Windows Node 24, installed DeepSeek Harness 0.1.2-rc.1: the standalone probe
  and `real-host-compat` wrapper each passed **9/9** fixed assertions.
- The temporary ledger contained exactly one shadow run, with the expected
  task/agent/tool binding, `hostOutcome.status: missing`, zero outcome
  observations, exactly one `shadow_outcome_missing` attention reason and zero
  labels. The synthetic tool body ran once, and the host's one late result
  reached the Agent after observer removal without changing that ledger row.
- Loader readiness at unload reported observer drained, owned kernel closed
  and `shutdownMissingResults: 1`. The fixed final marker and natural process
  exit were also required; a zero exit by itself does not pass the probe.
- The offline regression checks reject changed evidence claims, malformed
  success receipts, mismatched child exit status and missing installation.

## Boundaries

This proves **result absent at observer unload**, followed by a deliberately
late result. It does not prove that the process never produces a result, or
that an arbitrary host tool, a forever-hung admission/storage callback, or
the entire host process has a total shutdown deadline. `missing` means the
observer did not record a host outcome; it is not evidence that the tool did
nothing, an `unknown` report, a ground-truth label or permission to retry.
No real provider, credential, default profile, transcript or production tool
was used. All claims remain pinned to this installed host revision and the
synthetic, isolated fixture.
