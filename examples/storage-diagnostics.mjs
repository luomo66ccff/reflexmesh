#!/usr/bin/env node
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { evidenceMain } from '../adapters/evidence-cli.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
class DemoOptionsError extends Error {}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run demo:storage -- [--out-dir NEW_DIRECTORY]\nCreates only synthetic local records, no model or tools. Explicit new directory keeps an inspectable ledger; otherwise temporary files are removed.\nFor quoted paths containing spaces on Windows, build first then use node examples/storage-diagnostics.mjs --out-dir "NEW DIRECTORY" directly.\n'); return 0;
  }
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--out-dir' && argv[1])) throw new DemoOptionsError('Invalid storage demo options');
  const root = realpathSync(tmpdir()), keep = argv.length > 0;
  const directory = keep ? resolve(argv[1]) : mkdtempSync(join(root, 'reflexmesh-storage-demo-'));
  if (keep) mkdirSync(directory, { mode: 0o700 });
  let kernel;
  try {
    const path = join(directory, 'synthetic.sqlite'); let now = 1000;
    kernel = new SqliteKernel(path, { clock: () => now });
    const claim = key => kernel.claim({ key, owner: 'fixture-only', requestDigest: digest(key), leaseMs: 100, evidence: { synthetic: true } }).handle;
    const completed = claim('completed'); kernel.complete(completed, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' } });
    const unknown = claim('reviewed-unknown'); kernel.append(unknown, { kind: 'action.started', details: { synthetic: true, toolActuallyExecuted: false } });
    claim('admitted'); now = 1101;
    kernel.reviewRecovery({ schemaVersion: 1, id: 'fixture-review', runKey: 'reviewed-unknown', expectedEpoch: 1,
      inputDigest: digest('reviewed-unknown'), resolution: 'confirmed_not_executed', evidenceDigest: digest({ fixture: true }),
      evidenceRef: 'fixture:storage-demo', actorRef: 'fixture:operator', reason: 'Synthetic no-execution example', quiescent: true });
    kernel.beginClaudeHookPairing({ key: 'pair-only', callDigest: digest('call'), actionDigest: digest('action'), deploymentDigest: digest('deployment') });
    kernel.close(); kernel = undefined;
    output.write('SYNTHETIC storage lesson: completed and reviewed-UNKNOWN runs still retain admission guards; a pair-only reservation is not expendable. No tool or model ran.\n');
    await evidenceMain(['storage', '--db', path, '--scan-limit', '1000'], output);
    output.write('\nLower the scan limit to see why a partial sample is not a total:\n');
    await evidenceMain(['storage', '--db', path, '--scan-limit', '1'], output);
    output.write(keep ? `Inspectable synthetic ledger kept in ${JSON.stringify(directory)}.\n`
      : 'Temporary synthetic demonstration files are removed after this run. The storage inspector itself never deletes ledger data.\n');
    return 0;
  } finally {
    kernel?.close();
    if (!keep) {
      const target = realpathSync(directory);
      if (dirname(target) !== root || !basename(target).startsWith('reflexmesh-storage-demo-')) throw new Error('Unsafe storage demo cleanup');
      rmSync(target, { recursive: true, force: true });
    }
  }
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    process.stderr.write(error instanceof DemoOptionsError
      ? 'Expected --out-dir NEW_DIRECTORY only. For paths with spaces, build first and use node examples/storage-diagnostics.mjs --out-dir "NEW DIRECTORY" directly.\n'
      : 'ReflexMesh storage demo failed; build first and use a new output directory.\n'); process.exitCode = 1;
  }
}
