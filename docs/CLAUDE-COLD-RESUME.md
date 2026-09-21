# Cold resume and evidence needing review

This opt-in check uses installed **Windows Claude Code 2.1.263** with synthetic
localhost Messages and one fixed, in-memory MCP tool. There is no account,
paid model inference, Jev prediction or default-profile access. ReflexMesh is
still a shadow observer, not a host execution controller.

```powershell
npm ci --ignore-scripts
npm run compat:claude-resume -- --claude-command 'C:\path\to\claude.exe'
```

Other platforms/host revisions fail the preflight rather than silently broadening
support. The check has two scenarios, each with two independent native processes:

1. First process records a tool result and exits normally. A second process
   resumes the persisted session with a new explicit summary. Old decision,
   pairing and outcome remain unchanged; the new call binds to the new summary.
2. First process enters the memory-only tool, which holds at a barrier. Only
   after the original tool call is present in the temporary transcript and its
   completed shadow decision/ready pairing/zero outcomes are observable does the
   probe terminate its own process tree. The next process starts only after a
   direct-child close receipt, resumes with a new prompt without a summary
   marker, and uses a new call ID. The previous cached summary is not inherited.

The second scenario checks the public `evidence attention --json` interface:
the old record stays `run.state=completed`, `hostOutcome.status=missing`,
`recovery.required=false`, with `shadow_outcome_missing`. No UNKNOWN execution
tombstone is invented and no result is synthesized. Both scenarios retain zero
independent labels and an empty summary cache at normal final exit.

## What makes this an actual resume

The first process uses an explicit fresh session UUID. Session persistence is
enabled only in a newly created private synthetic config directory. The second
process uses `--resume` with the exact, bounded, regular `.jsonl` file from that
directory; there is no global session-ID search or fallback. The fixture checks
old and new synthetic prompt history, native calls and result content, different
process identities, session continuity and exact ledger/action/task/result
digests. Neither a repeated UUID nor exit code zero alone can pass.

Installed 2.1.263 removes the unfinished tool-use block from its resumed Messages
view and inserts a fixed assistant placeholder. The pinned fixture checks that
shape, but **the placeholder is not a tool result**. The original call was
verified in the persisted transcript before termination; its ReflexMesh ledger
stays unchanged with no result. A future host shape change must fail this fixture
until separately reviewed, not be accepted by a permissive text search.

The official [CLI reference](https://code.claude.com/docs/en/cli-reference)
documents explicit session IDs, persisted-session resume and absolute transcript
paths. The tested behavior here is pinned to the installed revision, not a claim
about every version described by the live documentation.

## Isolation and limits

The runner reuses doctor-generated production env/hooks unchanged. It scrubs
inherited ReflexMesh settings, allows only essential OS environment values,
uses fresh Claude/Anthropic/plugin stores and rejects ambient ancestor/managed
configuration. Built-in tools are disabled; the only configured MCP tool accepts
one fixed phase and returns fixed synthetic content from localhost. Unexpected
requests, protocol rejections, history mismatch, hook warnings, missing pairs
or reordered lifecycle events fail acceptance. Node 22's exact SQLite
experimental warning is the only permitted nonempty hook stderr.

Temporary synthetic session/profile/ledger files are closed and removed after
canonical direct-child path checks. No real user session is read or removed.
Termination targets only the spawned test PID/tree and is best-effort for
descendants; this is not an OS sandbox, network-egress proof, or proof that every
possible descendant stopped. Existing user settings and stored credentials are
not changed. ReflexMesh's observer itself still does not read transcripts.

Only **resume with an explicit new prompt** is covered. Unattended continuation,
forked children, repeated host delivery, default profiles, real model decisions,
actual cancellation hooks, arbitrary tools, remote side effects and a complete
cross-host restart matrix remain unverified. The synthetic transport requests
no retry and exact entry counts detect one in these scenarios; shadow mode
cannot prevent a host/model from retrying an unknown external action.

See [attention semantics](EVIDENCE.md#find-evidence-that-needs-attention),
[pairing limits](CLAUDE-HOOK-PAIRING.md) and the [dated validation](VALIDATION-CLAUDE-COLD-RESUME.md).
