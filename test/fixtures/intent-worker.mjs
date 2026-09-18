import { IntentCache } from '../../adapters/intent-cache.mjs';
let cache;
try {
  cache = new IntentCache(process.argv[2], { tenantId: 't', scope: 'p' });
  cache.capture({ harness: 'claude-code', sessionId: process.argv[3], agentId: 'root' }, `ReflexMesh-Intent: task ${process.argv[3]}`);
  process.send({ ok: true });
} catch { process.send({ ok: false }); }
finally { cache?.close(); process.disconnect(); }
