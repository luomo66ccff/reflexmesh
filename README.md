# ReflexMesh

**把概率式语义判断，接到可审计、默认不执行的工作流中。**

A provider-neutral, event-driven semantic decision runtime for AI agents and services.

> **Status: v0.1 development prototype, not a production security boundary.**
> The initial runtime is implemented and locally validated. The repository is now published at `luomo66ccff/reflexmesh`; live Jev inference and remote CI still require verification.

## What runs today

```text
Event -> versioned Decision Pack -> Jev / Mock Provider
                                      |
                               validated answers
                                      |
                              deterministic Policy
                                      |
                 shadow / block / assess / authorized read
                                      |
                                audit Outcome
```

| Module | Implemented scope |
| --- | --- |
| Runtime | In-process event processing, immutable snapshots, explicit deadlines, default shadow mode |
| Decision Packs | Typed `noul`, `choice`, `score`; versioned rules; fail-closed fallback |
| Jev provider | Server-side HTTP adapter, strict response validation, bounded response size, abort propagation |
| Memory Governor | Admission recommendations: propose persistent/temporary storage, drop, privacy review, conflict escalation |
| Tool preflight | Intent assessment plus **separate host authorization**; only registered reads execute in v0.1 |
| Audit | Memory ledger and single-process append-only JSONL sink; raw state/arguments omitted by runtime |
| Idempotency | In-flight coalescing and retained tombstones **within one runtime instance only** |
| Speculation | Cost/latency-aware **planner**, not an executing prefetch/cache system |
| Calibration | Brier score and binned ECE for explicit externally labeled datasets; no automatic policy tuning |

Not implemented: distributed event bus, persistent idempotency, actual memory database integration, live prefetch/cache reuse, human approval protocol, Saga execution/compensation, MCP server, HTTP gateway, dashboard, or production benchmarks. See [ROADMAP](docs/ROADMAP.md).

## Run locally

Requirements: Node.js **22+** and npm. Runtime has **zero external runtime dependencies**; the sole build dependency is pinned TypeScript 5.8.3.

```bash
npm ci --ignore-scripts
npm run check
npm run demo
```

The default demo is entirely offline. Its probabilities and evaluation labels are **synthetic fixtures**, not Jev predictions. It demonstrates memory admission in shadow mode, an explicitly authorized local read, duplicate coalescing, a speculation plan, and a JSONL audit log.

The source archive may include `dist/` for a dependency-free preview:

```bash
node examples/workflow.mjs
```

`dist/` is generated, ignored by Git, and rebuilt by CI. Do not edit it.

## Minimal application integration

```js
import {
  ReflexMesh, MemoryLedger, MockProvider, toolPreflightPack,
} from './dist/index.js';

const provider = new MockProvider(() => ({
  model: 'fixture-not-real-jev',
  answers: {
    intentMatch: { type: 'noul', noul: 0.98 },
    injection: { type: 'noul', noul: 0.01 },
  },
}));

const mesh = new ReflexMesh({ provider, ledger: new MemoryLedger() })
  .registerPack(toolPreflightPack);

const result = await mesh.run({
  id: crypto.randomUUID(),
  type: 'tool.requested',
  source: 'example-app',
  tenantId: 'example-tenant',
  time: new Date().toISOString(),
  state: { userIntent: 'Read the project README.' },
}, {
  packId: 'tool-preflight',
  action: { toolId: 'files.read', args: { path: 'README.md' } },
});

console.log(result.status); // shadow: no tool execution
```

For active reads, the host must explicitly select `mode: 'active'`, register the tool, supply a trusted principal, and implement `authorize`. An `allow` model policy verdict **does not authorize an action**. Writes/destructive tools remain blocked regardless of scores or host authorization in v0.1.

The event state is untrusted evidence, not policy. Actual tool ID/arguments supplied to `run()` are included separately in the provider state, and registered tool capabilities come from trusted host code.

## Use real Jev

Only run this after obtaining your own TypeSafe access and considering which data may leave your application. Keys never go into the browser, source tree, or GitHub issue text.

PowerShell:

```powershell
$env:TYPESAFE_API_KEY = "your-key-kept-locally"
$env:TYPESAFE_MODEL = "jev-latest"
npm run demo:jev
```

Bash:

```bash
export TYPESAFE_API_KEY='your-key-kept-locally'
export TYPESAFE_MODEL='jev-latest'
npm run demo:jev
```

`jev-latest` is an experimental alias, not a pin. Use a model ID supported by your account and validate it against a labeled dataset before any production use. This adapter does not automatically load `.env`, does not retry, and rejects cross-origin redirects. The runtime supplies the overall decision deadline.

**Verification boundary:** the HTTP shape was checked against TypeSafe's official SDK source. Offline injected-transport tests pass. No real TypeSafe key was supplied during preparation, so successful live inference, pricing, latency, model availability and calibration have **not** been established. See [SOURCES](docs/SOURCES.md).

## Repository

Canonical repository: `https://github.com/luomo66ccff/reflexmesh`

The included `scripts/publish-github.mjs` is retained as a guarded bootstrap helper for forks or renamed deployments. It refuses to overwrite an existing target repository.

## Project layout

```text
src/core/             contracts, validation, canonicalization, policy
src/runtime/          event execution and deadlines
src/providers/        mock and Jev HTTP adapters
src/packs/            memory admission and tool preflight
src/observability/    memory ledger and calibration statistics
src/scheduler/        speculative planning only
adapters/             local JSONL audit adapter
examples/             offline and explicit live-Jev examples
test/                 offline tests
scripts/              guarded GitHub publication
.github/workflows/    CI configuration
docs/                 architecture, roadmap, sources, verification
```

One package first, with module boundaries preserved. A multi-package monorepo should follow real independent consumers, not precede a working runtime.

## Safety and reliability limits

Read [SECURITY.md](SECURITY.md) before connecting any real tools or private data. In particular:

- A classifier is not an authorization system, and high confidence is not proof of correctness.
- JSONL persistence does **not** make the in-memory idempotency store durable. A process restart loses deduplication.
- A timed-out tool may still finish; the runtime reports `recovery_required` and does not retry it automatically.
- Memory directives are suggestions, not permission to retain sensitive data; enforce consent, expiry and deletion in host code.
- No incident after execution is not a valid ground-truth label that an action was safe.

## License

MIT. This prototype is not affiliated with or endorsed by TypeSafe AI. No Jev model weights are included.
