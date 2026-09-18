import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { ShadowBoundary } from '../adapters/shadow-boundary.mjs';

const directory = await mkdtemp(join(tmpdir(), 'reflexmesh-demo-'));
let kernel, predictions = 0;
try {
  const provider = new MockProvider(() => { predictions++; return { model: 'synthetic-demo', answers: {
    intentMatch: { type: 'noul', noul: 0.96 }, injection: { type: 'noul', noul: 0.01 },
  } }; });
  const options = { provider, pack: toolPreflightPack, tenantId: 'demo', scope: 'demo', binding: {
    providerId: 'mock', modelId: 'synthetic-demo', revision: 'fixture-1', calibrationRef: null,
    authorizationRevision: 'host-owned-shadow', toolsetRevision: 'demo-1',
  } };
  const call = { schemaVersion: 1, harness: 'codex', sessionId: 'demo-session', agentId: 'root',
    callId: 'read-1', toolName: 'files.read', arguments: { path: 'README.md' } };
  kernel = new SqliteKernel(join(directory, 'demo.sqlite'));
  let boundary = new ShadowBoundary({ ...options, kernel });
  const original = await boundary.before(call, 'Read README');
  boundary.after(call, 'succeeded', { testFixture: 'simulated tool result; no tool actually executed' }, 'test-oracle');
  kernel.close(); kernel = undefined;
  kernel = new SqliteKernel(join(directory, 'demo.sqlite'));
  boundary = new ShadowBoundary({ ...options, kernel });
  const restored = await boundary.before(call, 'Read README');
  const candidate = structuredClone(toolPreflightPack); candidate.version = 'counterfactual'; candidate.rules[2].all[0].value = 0.99;
  const replay = boundary.replay(call, candidate);
  console.log(JSON.stringify({ demo: 'SYNTHETIC FIXTURES ONLY; no real Jev/tool calls',
    original: original.verdict, afterReopen: { replayed: restored.replayed, providerCalls: predictions },
    counterfactual: { ...replay }, labels: boundary.inspect(call).labels.length,
  }, null, 2));
} finally { kernel?.close(); await rm(directory, { recursive: true, force: true }); }
