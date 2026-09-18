import { ReflexMesh, MockProvider, MemoryLedger, memoryAdmissionPack, toolPreflightPack, planSpeculation, calibrationReport } from '../dist/index.js';
import { JsonlLedger } from '../adapters/jsonl-ledger.mjs';

const provider = new MockProvider((_state, questions) => ({
  model: 'mock-demo-not-real-jev',
  answers: Object.fromEntries(Object.keys(questions).map(name => [name, {
    type: 'noul', noul: ['useful', 'stable', 'intentMatch'].includes(name) ? 0.96 : 0.01,
  }])),
}));
const event = (type, state) => ({ id: crypto.randomUUID(), type, source: 'local-demo', tenantId: 'demo', time: new Date().toISOString(), state });
const ledger = new MemoryLedger();
const shadow = new ReflexMesh({ provider, ledger }).registerPack(memoryAdmissionPack);
const memoryResult = await shadow.run(event('memory.candidate', { candidate: 'This example project uses TypeScript.', existing: [] }), { packId: 'memory-admission' });
console.log('\n1. Memory admission (SHADOW; nothing persisted):');
console.log(JSON.stringify({ status: memoryResult.status, verdict: memoryResult.verdict }, null, 2));

const active = new ReflexMesh({
  provider, ledger, mode: 'active',
  // Trusted host authorization for exactly one local demo tool. Not model-derived.
  authorize: (principal, action) => principal.id === 'demo-user' && action.toolId === 'demo.readStatus',
}).registerPack(toolPreflightPack).registerTool({
  id: 'demo.readStatus', effect: 'read', idempotent: true, speculatable: true,
  execute: async () => ({ service: 'example', status: 'healthy' }),
});
const request = event('tool.requested', { userIntent: 'Read the local example service status.' });
const options = { packId: 'tool-preflight', principal: { id: 'demo-user', tenantId: 'demo' }, action: { toolId: 'demo.readStatus', args: {} } };
const [first, duplicate] = await Promise.all([active.run(request, options), active.run(request, options)]);
console.log('\n2. Authorized local read (coalesced duplicate):');
console.log(JSON.stringify({ status: first.status, output: first.output, sameResult: first === duplicate }, null, 2));

console.log('\n3. Speculation plan ONLY; no tools are prefetched:');
console.log(planSpeculation([
  { id: 'local-search', probability: 0.8, latencySavedMs: 200, costUsd: 0.0001, riskPenaltyUsd: 0, effect: 'read', authorized: true, idempotent: true, speculatable: true, sensitive: false },
  { id: 'deploy', probability: 0.99, latencySavedMs: 5000, costUsd: 0, riskPenaltyUsd: 0, effect: 'write', authorized: true, idempotent: false, speculatable: false, sensitive: false },
], { latencyValueUsdPerMs: 0.00001, budgetUsd: 0.001, maxParallel: 2 }).map(x => ({ id: x.id, expectedNetUsd: x.expectedNetUsd })));
console.log('\n4. Calibration of SYNTHETIC labeled fixtures (not a Jev benchmark):');
const report = calibrationReport([{ probability: 0.1, label: 0 }, { probability: 0.9, label: 1 }]);
console.log({ count: report.count, brier: report.brier, ece: report.ece });
const fileLedger = new JsonlLedger('demo-audit.jsonl');
for (const row of ledger.list()) await fileLedger.append(row);
console.log('\nAudit records written to demo-audit.jsonl; raw state and tool arguments omitted.');
