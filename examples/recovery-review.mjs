import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

// Deliberately synthetic evidence and clock; no provider, tool or external service is called.
const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-recovery-demo-'));
let kernel;
try {
  let now = 0;
  const path = join(dir, 'demo.sqlite'), key = digest({ fixture: 'recovery-demo' }), inputDigest = digest({ action: 'fixture-only' });
  kernel = new SqliteKernel(path, { clock: () => now });
  const { handle } = kernel.claim({ key, requestDigest: inputDigest, owner: 'fixture-worker', leaseMs: 100, evidence: { synthetic: true } });
  kernel.append(handle, { kind: 'action.started', details: { toolId: 'not-actually-executed' } });
  now = 101;
  const current = kernel.recoverySnapshot(key);
  const review = { schemaVersion: 1, id: 'fixture-review', runKey: key, expectedEpoch: current.epoch, inputDigest,
    resolution: 'confirmed_not_executed', evidenceDigest: digest({ testOracle: 'nothing executed' }),
    evidenceRef: 'fixture:recovery-demo', actorRef: 'fixture:operator', reason: 'Synthetic no-execution example', quiescent: true };
  const preview = kernel.previewRecovery(review);
  const recorded = kernel.reviewRecovery(review);
  kernel.close(); kernel = new SqliteKernel(path);
  const afterRestart = kernel.recoverySnapshot(key);
  const repeated = kernel.claim({ key, requestDigest: inputDigest, owner: 'another-worker', leaseMs: 100, evidence: {} });
  console.log(JSON.stringify({ demo: 'SYNTHETIC recovery review; no model or tool executed',
    preview, recorded, afterRestart: { state: afterRestart.state, resolution: afterRestart.latestReview.review.resolution },
    nextAdmission: repeated.kind, automaticRetry: false, pendingQueueSize: kernel.listRecoveries().items.length,
  }, null, 2));
} finally { kernel?.close(); await rm(dir, { recursive: true, force: true }); }
