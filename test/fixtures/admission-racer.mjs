import { SqliteKernel } from '../../adapters/sqlite-kernel.mjs';
let kernel, failure;
try { kernel = new SqliteKernel(process.argv[2]); }
catch (error) { failure = { kind: 'fixture_error', stage: 'open', code: error.code ?? 'unknown', errcode: error.errcode ?? null }; }
// Even a failed opener remains alive to report a diagnostic instead of leaving the parent waiting for IPC.
process.once('message', () => {
  let reply = failure;
  try {
    if (kernel) reply = kernel.claim({ key: 'race', requestDigest: 'same-action', owner: String(process.pid), leaseMs: 10000, evidence: {} });
  } catch (error) { reply = { kind: 'fixture_error', stage: 'claim', code: error.code ?? 'unknown', errcode: error.errcode ?? null }; }
  finally { kernel?.close(); }
  process.send(reply, () => process.disconnect());
  if (reply.kind === 'fixture_error') process.exitCode = 1;
});
process.send({ ready: true });
