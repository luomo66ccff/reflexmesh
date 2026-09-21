#!/usr/bin/env node
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { comparisonFixture, fixtureDeployment } from './evaluation-fixture.mjs';
import { runEvaluation } from '../adapters/evaluation-runner.mjs';
import { evaluationMain } from '../adapters/evaluation-cli.mjs';
import { reserveEvaluationOutput } from '../adapters/evaluation-files.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run demo:comparison -- [--out-dir NEW_DIRECTORY]\nSynthetic paired-coverage lesson; no model, credentials or tools. Default temporary files are removed; explicit new directory preserves editable artifacts.\n'); return 0;
  }
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--out-dir' && argv[1])) throw new Error('Invalid demo options');
  const root = realpathSync(tmpdir()), keep = argv.length > 0;
  const directory = keep ? resolve(argv[1]) : mkdtempSync(join(root, 'reflexmesh-comparison-demo-'));
  if (keep) mkdirSync(directory, { mode: 0o700 }); // Existing outputs are not overwritten.
  try {
    const { dataset, labels } = comparisonFixture();
    const save = (name, value) => { const file = reserveEvaluationOutput(join(directory, name)); try { file.finish(value); } finally { file.close(); } };
    save('dataset.json', dataset); save('labels.json', labels);
    for (const side of ['champion', 'challenger']) {
      const predictions = await runEvaluation({ dataset, ...fixtureDeployment(side), deploymentId: `fixture-${side}`, id: `${side}-run`, maxRequests: 4 });
      save(`${side}.json`, predictions);
    }
    output.write('SYNTHETIC lesson: a candidate skips harder cases, so its unpaired average looks better. Compare the shared labeled cases instead.\n');
    await evaluationMain(['compare', '--dataset', join(directory, 'dataset.json'), '--labels', join(directory, 'labels.json'),
      '--champion', join(directory, 'champion.json'), '--challenger', join(directory, 'challenger.json'), '--out', join(directory, 'report.json')], output);
    output.write(keep ? `Editable synthetic artifacts saved in ${JSON.stringify(directory)}.\n` : 'Temporary synthetic artifacts removed after the lesson; use --out-dir NEW_DIRECTORY to keep editable inputs.\n');
    return 0;
  } finally {
    if (!keep) { const target = realpathSync(directory); if (dirname(target) !== root || !basename(target).startsWith('reflexmesh-comparison-demo-')) throw new Error('Unsafe demo cleanup');
      rmSync(target, { recursive: true, force: true }); }
  }
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write('ReflexMesh comparison demo failed; use a new output directory and build first.\n'); process.exitCode = 1; }
}
