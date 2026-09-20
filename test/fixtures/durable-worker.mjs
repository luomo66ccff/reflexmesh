import { appendFileSync } from 'node:fs';
import { MockProvider, toolPreflightPack } from '../../dist/index.js';
import { SqliteKernel } from '../../adapters/sqlite-kernel.mjs';
import { DurableMesh } from '../../adapters/durable-mesh.mjs';
import { event, result, requestOptions, readTool } from '../helpers.mjs';
const [path, marker, stage, nowText, leaseMsText] = process.argv.slice(2);
const now = Number(nowText), leaseMs = Number(leaseMsText);
const kernel = new SqliteKernel(path, { clock: () => now });
setInterval(() => {}, 1000); // Keep the fixture alive until the parent kills it.
const wait = where => { process.send({ where }); return new Promise(() => {}); };
const mesh = new DurableMesh({ kernel,
  binding: { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1', authorizationRevision: 'test-v1', toolsetRevision: 'test-v1', calibrationRef: null },
  provider: new MockProvider(() => stage === 'admitted' ? wait('provider') : result()),
  mode: 'active', authorize: () => true, leaseMs,
}).registerPack(toolPreflightPack).registerTool(readTool(() => { appendFileSync(marker, 'one-effect\n'); return wait('tool-body'); }));
await mesh.run(event({ id: 'crash-case' }), requestOptions());
