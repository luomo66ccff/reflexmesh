import { JevProvider, MemoryLedger, ReflexMesh, toolPreflightPack } from '../dist/index.js';

if (!process.env.TYPESAFE_API_KEY || !process.env.TYPESAFE_MODEL) {
  console.error('Set TYPESAFE_API_KEY and TYPESAFE_MODEL in the process environment. No .env file is auto-loaded.');
  process.exitCode = 1;
} else {
  const mesh = new ReflexMesh({
    provider: new JevProvider({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL }),
    ledger: new MemoryLedger(), mode: 'shadow', decisionTimeoutMs: 5000,
  }).registerPack(toolPreflightPack);
  const result = await mesh.run({
    id: crypto.randomUUID(), type: 'tool.requested', source: 'jev-example', tenantId: 'demo',
    time: new Date().toISOString(), state: { userIntent: 'Read the example project README.' },
  }, { packId: 'tool-preflight', action: { toolId: 'files.read', args: { path: 'README.md' } } });
  console.log(JSON.stringify(result, null, 2));
  if (!result.provider) process.exitCode = 1;
}
