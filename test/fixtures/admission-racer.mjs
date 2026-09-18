import { SqliteKernel } from '../../adapters/sqlite-kernel.mjs';
const kernel = new SqliteKernel(process.argv[2]);
process.send({ ready: true });
process.once('message', () => {
  const admitted = kernel.claim({ key: 'race', requestDigest: 'same-action', owner: String(process.pid), leaseMs: 10000, evidence: {} });
  process.send({ kind: admitted.kind }); kernel.close(); process.disconnect();
});
