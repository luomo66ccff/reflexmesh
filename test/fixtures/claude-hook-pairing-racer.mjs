import { SqliteKernel, digest } from '../../adapters/sqlite-kernel.mjs';

const [path, action] = process.argv.slice(2);
const descriptor = { key: 'process-race', callDigest: digest('call'), actionDigest: digest('action'),
  deploymentDigest: digest({ packDigest: digest('pack'), binding: { providerId: 'abstain' }, mode: 'shadow' }) };
const observation = { id: 'outcome', status: 'succeeded', provenance: 'harness-reported', evidenceDigest: digest('output') };
const kernel = new SqliteKernel(path);

if (action === 'hold') {
  const receipt = kernel.beginClaudeHookPairing(descriptor);
  process.send({ kind: 'reserved', receipt }, () => {
    // The test kills this process after receiving the durable receipt.
  });
} else {
  process.send({ kind: 'ready' });
  process.once('message', message => {
    if (message !== 'go') return;
    let result;
    try {
      if (action === 'begin') result = { kind: 'ok', receipt: kernel.beginClaudeHookPairing(descriptor) };
      else if (action === 'post') {
        kernel.observeClaudeHookPairing(descriptor, observation);
        result = { kind: 'ok' };
      } else throw new Error('Unknown fixture action');
    } catch (error) { result = { kind: 'rejected', name: error.name, message: error.message }; }
    kernel.close();
    process.send(result, () => process.disconnect());
  });
}
