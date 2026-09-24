import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { evaluationMain, formatEvaluationReport, parseEvaluationOptions } from '../adapters/evaluation-cli.mjs';
import { EVALUATION_FILE_LIMIT, readEvaluationJson, reserveEvaluationOutput } from '../adapters/evaluation-files.mjs';
import { comparisonFixture, fixtureDeployment } from '../examples/evaluation-fixture.mjs';
import { runEvaluation } from '../adapters/evaluation-runner.mjs';
import { planEvaluation } from '../adapters/evaluation-plan.mjs';
import { canonical } from '../dist/index.js';
import { main as demo } from '../examples/provider-comparison.mjs';

const sink = () => ({ text: '', write(text) { this.text += text; } });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function directory(t) {
  const root = realpathSync(tmpdir()), path = mkdtempSync(join(root, 'reflexmesh-evaluation-cli-'));
  t.after(() => { const target = realpathSync(path); assert.equal(dirname(target), root);
    assert.ok(basename(target).startsWith('reflexmesh-evaluation-cli-')); rmSync(target, { recursive: true, force: true }); });
  return path;
}
async function fixtures(t) {
  const dir = directory(t), { dataset, labels } = comparisonFixture();
  for (const [name, value] of Object.entries({ dataset, labels })) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  for (const side of ['champion', 'challenger']) writeFileSync(join(dir, `${side}.json`), JSON.stringify(await runEvaluation({ dataset,
    ...fixtureDeployment(side), deploymentId: side, id: `${side}-run`, maxRequests: 4 })));
  return { dir, dataset, labels, args: ['compare', '--dataset', join(dir, 'dataset.json'), '--labels', join(dir, 'labels.json'),
    '--champion', join(dir, 'champion.json'), '--challenger', join(dir, 'challenger.json')] };
}
const runArgs = (dir, out = 'run.json') => ['run', '--dataset', join(dir, 'dataset.json'), '--deployment-id', 'bounded-run',
  '--id', 'bounded-run-1', '--out', join(dir, out), '--max-requests', '1', '--allow-remote'];
test('evaluation CLI validates exact options and explicit request budgets before any work', () => {
  assert.equal(parseEvaluationOptions([]).help, true); assert.equal(parseEvaluationOptions(['--help']).help, true);
  for (const args of [['wrong'], ['validate'], ['plan'], ['validate', '--dataset', 'a', '--dataset', 'b'],
    ['validate', '--dataset', 'a', '--unknown'], ['validate', '--dataset'], ['compare', '--dataset', 'a'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '0'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '1', '--allow-remote'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '1', '--labels', 'forbidden'],
    ['run', '--dataset', 'a'], [...runArgs('a'), '--labels', 'forbidden'],
    [...runArgs('a'), '--timeout-ms', 'NaN'], [...runArgs('a'), '--max-output-tokens', '4097'],
    runArgs('a').map(x => x === '1' ? '0' : x), runArgs('a').filter(x => x !== '--allow-remote')]) assert.throws(() => parseEvaluationOptions(args));
});
test('help, validate, plan and compare never inspect environment credentials or create a provider', async t => {
  const f = await fixtures(t), trap = { env: new Proxy({}, { get() { throw new Error('Credential access'); } }),
    createProvider() { throw new Error('Factory must not run'); } };
  const output = sink();
  assert.equal(await evaluationMain(['--help'], output, trap), 0);
  const validation = sink();
  assert.equal(await evaluationMain(['validate', '--dataset', join(f.dir, 'dataset.json'), '--labels', join(f.dir, 'labels.json'), '--json'], validation, trap), 0);
  assert.equal(JSON.parse(validation.text).labelIndependenceVerified, false);
  const files = ['dataset', 'labels', 'champion', 'challenger'].map(name => join(f.dir, `${name}.json`)), before = files.map(hash);
  const comparison = sink();
  const previousFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden'); };
  const plan = sink();
  try {
    assert.equal(await evaluationMain(['plan', '--dataset', join(f.dir, 'dataset.json'), '--provider', 'deepseek',
      '--max-requests', '2', '--json'], plan, trap), 0);
    assert.equal(await evaluationMain([...f.args, '--json'], comparison, trap), 0);
  }
  finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(files.map(hash), before);
  const preview = JSON.parse(plan.text);
  assert.equal(preview.requestUpperBound, 2);
  assert.equal(preview.deferredByRequestCapIfNoFailure, 2);
  assert.equal(preview.remoteAccess, false);
  assert.equal(preview.estimatedCostUsd, null);
  const report = JSON.parse(comparison.text), q = report.questions[0];
  assert.ok(q.availableSubset.challenger.metrics.brier < q.availableSubset.champion.metrics.brier);
  assert.ok(q.paired.delta.brier > 0); assert.equal(q.paired.count, 2);
  assert.equal(report.executionAllowed, false); assert.equal(report.promotionAllowed, false);
  assert.match(formatEvaluationReport(report), /different population; no direct delta/);
  assert.match(formatEvaluationReport(report), /SYNTHETIC/);
});
test('offline plan mirrors trusted provider compatibility and omits raw case state', async t => {
  const dir = directory(t), dataset = structuredClone(comparisonFixture().dataset);
  dataset.cases[0].state = { privateValue: 'DO_NOT_FORWARD_' + 'x'.repeat(16000) };
  const path = join(dir, 'dataset.json'); writeFileSync(path, JSON.stringify(dataset));
  const deepseek = planEvaluation({ dataset, provider: 'deepseek', maxRequests: 2 });
  assert.equal(deepseek.eligibleCases, 3);
  assert.equal(deepseek.unsupportedCases, 1);
  assert.equal(deepseek.requestUpperBound, 2);
  assert.equal(deepseek.deferredByRequestCapIfNoFailure, 1);
  assert.equal(deepseek.selectedCanonicalInputBytes, dataset.cases.slice(1, 3).reduce((sum, item) =>
    sum + Buffer.byteLength(canonical({ state: item.state, questions: dataset.pack.questions }), 'utf8'), 0));
  assert.equal(JSON.stringify(deepseek).includes('DO_NOT_FORWARD'), false);
  const jev = planEvaluation({ dataset, provider: 'jev', maxRequests: 4 });
  assert.equal(jev.eligibleCases, 4);
  assert.equal(jev.unsupportedCases, 0);
  assert.equal(jev.requestUpperBound, 4);
  assert.equal(jev.modelRouteVerified, false);
  assert.equal(jev.actualWireBytesVerified, false);
  const mixed = structuredClone(comparisonFixture().dataset);
  mixed.pack.questions.route = { type: 'choice', instructions: 'Select the route?', criteria: { a: 'A', b: 'B' } };
  assert.equal(planEvaluation({ dataset: mixed, provider: 'deepseek', maxRequests: 4 }).requestUpperBound, 0);
  assert.equal(planEvaluation({ dataset: mixed, provider: 'jev', maxRequests: 4 }).requestUpperBound, 4);
  const CLI = sink();
  assert.equal(await evaluationMain(['plan', '--dataset', path, '--provider', 'deepseek',
    '--max-requests', '2'], CLI, { env: new Proxy({}, { get() { throw new Error('Credential access'); } }),
    createProvider() { throw new Error('Provider constructed'); } }), 0);
  assert.match(CLI.text, /Compatible=3, unsupported=1/);
  assert.equal(CLI.text.includes('DO_NOT_FORWARD'), false);
  await assert.rejects(evaluationMain(['plan', '--dataset', path, '--provider', 'unknown',
    '--max-requests', '2'], sink()), /Select deepseek or jev/);
  assert.throws(() => planEvaluation({ dataset, provider: { toString() { throw new Error('Unsafe coercion'); } },
    maxRequests: 2 }), /Select deepseek or jev/);
});
test('imported non-fixture predictions remain pure local declarations, not authenticated measurements', async t => {
  const f = await fixtures(t);
  for (const side of ['champion', 'challenger']) {
    const path = join(f.dir, `${side}.json`), value = readEvaluationJson(path);
    value.origin = 'imported'; value.deployment.capabilities.probabilitySemantics = 'elicited-estimate';
    const { canonical } = await import('../dist/index.js');
    value.deployment.binding.capabilitiesDigest = createHash('sha256').update(canonical(value.deployment.capabilities)).digest('hex');
    writeFileSync(path, JSON.stringify(value));
  }
  const output = sink();
  assert.equal(await evaluationMain([...f.args, '--json'], output, { createProvider() { throw new Error('No model'); } }), 0);
  assert.equal(JSON.parse(output.text).sides.challenger.origin, 'imported');
  assert.equal(JSON.parse(output.text).labelset.labelIndependenceVerified, false);
});
test('CLI run reserves output before evaluation, excludes labels and gives a redacted status receipt', async t => {
  const f = await fixtures(t), out = join(f.dir, 'run.json'), output = sink(); let calls = 0;
  const createProvider = () => {
    const selected = fixtureDeployment('champion'), evaluate = selected.provider.evaluate.bind(selected.provider);
    return { ...selected, provider: { id: selected.provider.id, capabilities: selected.provider.capabilities,
      evaluate: (...args) => { calls++; assert.equal(readEvaluationJson(out).kind, 'reflexmesh-evaluation-incomplete'); return evaluate(...args); } } };
  };
  assert.equal(await evaluationMain(runArgs(f.dir), output, { createProvider }), 0);
  assert.equal(calls, 1); assert.equal(readEvaluationJson(out).rows.length, 4);
  const receipt = JSON.parse(output.text); assert.equal(receipt.toolsExecuted, 0); assert.equal(receipt.automaticRetryAllowed, false);
  assert.deepEqual(receipt.statuses, { ok: 1, unsupported: 0, failed: 0, not_attempted: 3 });
  assert.equal(output.text.includes('requestedKey'), false); assert.equal(output.text.includes('answers'), false);
});
test('existing, missing-parent and failed-finalization paths cause zero provider calls on re-entry', async t => {
  const f = await fixtures(t); let calls = 0;
  const createProvider = () => {
    const selected = fixtureDeployment('champion');
    return { ...selected, provider: { id: selected.provider.id, capabilities: selected.provider.capabilities,
      evaluate() { calls++; throw new Error('Must not run'); } } };
  };
  writeFileSync(join(f.dir, 'existing.json'), 'PRESERVE');
  await assert.rejects(evaluationMain(runArgs(f.dir, 'existing.json'), sink(), { createProvider }), /new file/);
  assert.equal(readFileSync(join(f.dir, 'existing.json'), 'utf8'), 'PRESERVE');
  await assert.rejects(evaluationMain(runArgs(f.dir, 'missing/run.json'), sink(), { createProvider }), /new file/);
  const output = reserveEvaluationOutput(join(f.dir, 'failed.json'));
  assert.throws(() => output.finish({ value: 'x'.repeat(EVALUATION_FILE_LIMIT) }), /not automatically repeat/);
  output.close(); assert.equal(readEvaluationJson(join(f.dir, 'failed.json')).kind, 'reflexmesh-evaluation-incomplete');
  await assert.rejects(evaluationMain(runArgs(f.dir, 'failed.json'), sink(), { createProvider }), /new file/);
  assert.equal(calls, 0);
});
test('failed CLI run writes a complete failure artifact, returns 2 and cannot silently retry it', async t => {
  const f = await fixtures(t); let calls = 0;
  const createProvider = () => {
    const selected = fixtureDeployment('champion');
    return { ...selected, provider: { id: selected.provider.id, capabilities: selected.provider.capabilities,
      evaluate() { calls++; throw new Error('PRIVATE_ERROR'); } } };
  };
  const output = sink(); assert.equal(await evaluationMain(runArgs(f.dir), output, { createProvider }), 2);
  assert.equal(calls, 1); const persisted = readEvaluationJson(join(f.dir, 'run.json'));
  assert.equal(persisted.rows[0].reasonCode, 'provider_error'); assert.equal(JSON.stringify(persisted).includes('PRIVATE'), false);
  await assert.rejects(evaluationMain(runArgs(f.dir), sink(), { createProvider })); assert.equal(calls, 1);
});
test('compare output is new-only and never overwrites source artifacts', async t => {
  const f = await fixtures(t), path = join(f.dir, 'dataset.json'), before = hash(path);
  await assert.rejects(evaluationMain([...f.args, '--out', path], sink()), /new file/);
  assert.equal(hash(path), before);
  const output = sink(), out = join(f.dir, 'report.json');
  assert.equal(await evaluationMain([...f.args, '--out', out, '--json'], output), 0);
  assert.deepEqual(readEvaluationJson(out), JSON.parse(output.text));
});
test('comparison demo keeps five editable artifacts only in an explicitly new directory', async t => {
  const dir = directory(t), out = join(dir, 'lesson'), output = sink();
  assert.equal(await demo(['--out-dir', out], output), 0);
  assert.deepEqual(readdirSync(out).sort(), ['challenger.json', 'champion.json', 'dataset.json', 'labels.json', 'report.json']);
  const report = readEvaluationJson(join(out, 'report.json'));
  assert.ok(Math.abs(report.questions[0].paired.delta.brier - 0.05) < 1e-12);
  assert.equal(report.questions[0].coverage.challenger.all.failed, 1);
  assert.match(output.text, /SYNTHETIC lesson/); assert.match(output.text, /brier=0.2/);
  const before = hash(join(out, 'report.json'));
  await assert.rejects(demo(['--out-dir', out], sink())); assert.equal(hash(join(out, 'report.json')), before);
});
test('comparison demo default cleans temporary artifacts; help performs no model work', async () => {
  const output = sink(); assert.equal(await demo([], output), 0); assert.match(output.text, /Temporary synthetic artifacts removed/);
  const help = sink(); assert.equal(await demo(['--help'], help), 0); assert.match(help.text, /no model/);
  await assert.rejects(demo(['--unknown'], sink()));
});
