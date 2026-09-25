import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { evaluationMain, formatEvaluationReport, parseEvaluationOptions } from '../adapters/evaluation-cli.mjs';
import { EVALUATION_FILE_LIMIT, readEvaluationJson, reserveEvaluationOutput } from '../adapters/evaluation-files.mjs';
import { comparisonFixture, fixtureDeployment } from '../examples/evaluation-fixture.mjs';
import { runEvaluation } from '../adapters/evaluation-runner.mjs';
import { planEvaluation } from '../adapters/evaluation-plan.mjs';
import { createEvaluationProvider } from '../adapters/evaluation-provider.mjs';
import { canonical, DEEPSEEK_ESTIMATE_CAPABILITIES, deepSeekRequestBody,
  JEV_CAPABILITIES, jevRequestBody } from '../dist/index.js';
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
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '1', '--model-id', 'route-only'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '1', '--provider-revision', 'revision-only'],
    ['plan', '--dataset', 'a', '--provider', 'deepseek', '--max-requests', '1', '--max-output-tokens', '64'],
    ['plan', '--dataset', 'a', '--provider', 'jev', '--max-requests', '1', '--model-id', 'm', '--provider-revision', 'r', '--max-output-tokens', '64'],
    ['run', '--dataset', 'a'], [...runArgs('a'), '--labels', 'forbidden'],
    [...runArgs('a'), '--expect-plan-digest', 'not-a-sha256'],
    [...runArgs('a'), '--expect-route-plan-digest', 'not-a-sha256'],
    [...runArgs('a'), '--expect-wire-plan-digest', 'not-a-sha256'],
    [...runArgs('a'), '--require-listed-model'],
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
  assert.deepEqual(preview.wirePreflight, { status: 'not_checked', reason: 'model_not_declared' });
  assert.equal(preview.deferredByRequestCapIfNoFailure, 2);
  assert.equal(preview.remoteAccess, false);
  assert.equal(preview.estimatedCostUsd, null);
  assert.match(preview.guardDigest, /^[a-f0-9]{64}$/);
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
  assert.notEqual(deepseek.guardDigest, jev.guardDigest);
  assert.notEqual(deepseek.guardDigest, planEvaluation({ dataset, provider: 'deepseek', maxRequests: 3 }).guardDigest);
  const mixed = structuredClone(comparisonFixture().dataset);
  mixed.pack.questions.route = { type: 'choice', instructions: 'Select the route?', criteria: { a: 'A', b: 'B' } };
  assert.equal(planEvaluation({ dataset: mixed, provider: 'deepseek', maxRequests: 4 }).requestUpperBound, 0);
  assert.equal(planEvaluation({ dataset: mixed, provider: 'jev', maxRequests: 4 }).requestUpperBound, 4);
  const CLI = sink();
  assert.equal(await evaluationMain(['plan', '--dataset', path, '--provider', 'deepseek',
    '--max-requests', '2'], CLI, { env: new Proxy({}, { get() { throw new Error('Credential access'); } }),
    createProvider() { throw new Error('Provider constructed'); } }), 0);
  assert.match(CLI.text, /Capability-compatible=3, capability-unsupported=1/);
  assert.match(CLI.text, /request-body check: not checked/);
  assert.match(CLI.text, /Plan guard: [a-f0-9]{64}/);
  assert.equal(CLI.text.includes('DO_NOT_FORWARD'), false);
  await assert.rejects(evaluationMain(['plan', '--dataset', path, '--provider', 'unknown',
    '--max-requests', '2'], sink()), /Select deepseek or jev/);
  assert.throws(() => planEvaluation({ dataset, provider: { toString() { throw new Error('Unsafe coercion'); } },
    maxRequests: 2 }), /Select deepseek or jev/);
});
test('declared routes check exact local request bodies without changing older guard meanings', () => {
  for (const [provider, instructionBytes, stateBytes] of [
    ['deepseek', 28000, 5000], ['jev', 250000, 10000],
  ]) {
    const dataset = structuredClone(comparisonFixture().dataset);
    dataset.pack.questions.match.instructions = 'q'.repeat(instructionBytes);
    dataset.cases[0].state = { blob: 's'.repeat(stateBytes) };
    const base = { dataset, provider, maxRequests: 1 };
    const capabilityOnly = planEvaluation(base);
    assert.equal(capabilityOnly.eligibleCases, 4);
    assert.equal(capabilityOnly.requestUpperBound, 1);
    assert.equal(capabilityOnly.wirePreflight.status, 'not_checked');
    const routed = planEvaluation({ ...base, modelId: 'test-model', revision: 'offline-v1' });
    assert.equal(routed.eligibleCases, 4);
    assert.equal(routed.requestUpperBound, 1);
    assert.equal(routed.wirePreflight.status, 'checked');
    assert.equal(routed.wirePreflight.sendableCases, 3);
    assert.equal(routed.wirePreflight.wireRejectedCases, 1);
    assert.equal(routed.wirePreflight.requestUpperBound, 1);
    assert.equal(routed.wirePreflight.deferredByRequestCapIfNoFailure, 2);
    assert.ok(routed.wirePreflight.selectedRequestBodyBytes > 0);
    assert.equal(routed.guardDigest, capabilityOnly.guardDigest);
    assert.equal(routed.actualWireBytesVerified, false);
    assert.equal(JSON.stringify(routed).includes('s'.repeat(100)), false);
    if (provider === 'deepseek') {
      assert.equal(routed.wirePreflight.maxOutputTokens, 512);
      const custom = planEvaluation({ ...base, modelId: 'test-model', revision: 'offline-v1', maxOutputTokens: 64 });
      assert.equal(custom.wirePreflight.maxOutputTokens, 64);
      assert.notEqual(custom.wirePreflight.selectedRequestBodyBytes, routed.wirePreflight.selectedRequestBodyBytes);
      assert.equal(custom.routeGuardDigest, routed.routeGuardDigest);
    }
  }
});
test('wire guard binds complete serialized bodies and output cap without redefining older guards', () => {
  const dataset = structuredClone(comparisonFixture().dataset);
  const route = { dataset, provider: 'deepseek', maxRequests: 1,
    modelId: 'test-model', revision: 'offline-v1' };
  const planned = planEvaluation(route);
  assert.equal(planEvaluation({ dataset, provider: 'deepseek', maxRequests: 1 }).wireGuardDigest, undefined);
  assert.match(planned.wireGuardDigest, /^[a-f0-9]{64}$/);
  const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const bodies = dataset.cases.map((item, index) => {
    const body = deepSeekRequestBody(route.modelId, item.state, dataset.pack.questions, 512);
    return { caseId: item.id, byteLength: Buffer.byteLength(body, 'utf8'),
      bodyDigest: sha(body), sendable: true, selected: index === 0 };
  });
  assert.equal(planned.wireGuardDigest, sha(canonical({ schemaVersion: 1,
    kind: 'reflexmesh-evaluation-wire-plan-guard', routeGuardDigest: planned.routeGuardDigest,
    serializerId: 'deepseek-chat-completions-json-v1', effectiveMaxOutputTokens: 512,
    orderedEligibleBodiesDigest: sha(canonical(bodies)) })));
  assert.equal(planned.wireGuardDigest, planEvaluation({ ...route, maxOutputTokens: 512 }).wireGuardDigest);
  const smaller = planEvaluation({ ...route, maxOutputTokens: 64 });
  assert.notEqual(smaller.wireGuardDigest, planned.wireGuardDigest);
  assert.equal(smaller.routeGuardDigest, planned.routeGuardDigest);
  assert.equal(smaller.guardDigest, planned.guardDigest);
  const reordered = structuredClone(dataset);
  for (const item of reordered.cases) item.state = Object.fromEntries(Object.entries(item.state).reverse());
  const reorderedPlan = planEvaluation({ ...route, dataset: reordered });
  assert.equal(reorderedPlan.dataset.digest, planned.dataset.digest);
  assert.equal(reorderedPlan.routeGuardDigest, planned.routeGuardDigest);
  assert.notEqual(reorderedPlan.wireGuardDigest, planned.wireGuardDigest);
  const deferredOnly = structuredClone(dataset);
  deferredOnly.cases[3].state = Object.fromEntries(Object.entries(deferredOnly.cases[3].state).reverse());
  assert.notEqual(planEvaluation({ ...route, dataset: deferredOnly }).wireGuardDigest, planned.wireGuardDigest);
  const oversized = structuredClone(dataset);
  oversized.pack.questions.match.instructions = 'q'.repeat(28000);
  oversized.cases[0].state = { blob: 's'.repeat(5000), tag: 'fixture' };
  const oversizedPlan = planEvaluation({ ...route, dataset: oversized });
  assert.equal(oversizedPlan.wirePreflight.wireRejectedCases, 1);
  const reorderedRejected = structuredClone(oversized);
  reorderedRejected.cases[0].state = { tag: 'fixture', blob: 's'.repeat(5000) };
  const rejectedPlan = planEvaluation({ ...route, dataset: reorderedRejected });
  assert.equal(rejectedPlan.routeGuardDigest, oversizedPlan.routeGuardDigest);
  assert.notEqual(rejectedPlan.wireGuardDigest, oversizedPlan.wireGuardDigest);
  const jev = planEvaluation({ ...route, provider: 'jev' });
  assert.match(jev.wireGuardDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(jev.wireGuardDigest, planned.wireGuardDigest);
  const jevBodies = dataset.cases.map((item, index) => {
    const body = jevRequestBody(route.modelId, item.state, dataset.pack.questions);
    return { caseId: item.id, byteLength: Buffer.byteLength(body, 'utf8'),
      bodyDigest: sha(body), sendable: true, selected: index === 0 };
  });
  assert.equal(jev.wireGuardDigest, sha(canonical({ schemaVersion: 1,
    kind: 'reflexmesh-evaluation-wire-plan-guard', routeGuardDigest: jev.routeGuardDigest,
    serializerId: 'jev-systemone-json-v1', effectiveMaxOutputTokens: null,
    orderedEligibleBodiesDigest: sha(canonical(jevBodies)) })));
});
test('plan guard rejects changed dataset, provider or cap before key access and output reservation', async t => {
  const f = await fixtures(t), plan = planEvaluation({ dataset: f.dataset, provider: 'deepseek', maxRequests: 1 });
  const changed = structuredClone(f.dataset);
  changed.cases[0].state.observedKey = 'changed';
  const changedPath = join(f.dir, 'changed-dataset.json'); writeFileSync(changedPath, JSON.stringify(changed));
  const args = (datasetPath, cap, out) => ['run', '--dataset', datasetPath, '--deployment-id', 'guarded-run',
    '--id', 'guarded-run-1', '--out', out, '--max-requests', String(cap), '--allow-remote',
    '--expect-plan-digest', plan.guardDigest];
  let factoryCalls = 0;
  for (const [name, datasetPath, cap, provider] of [
    ['dataset', changedPath, 1, 'deepseek'],
    ['provider', join(f.dir, 'dataset.json'), 1, 'jev'],
    ['budget', join(f.dir, 'dataset.json'), 2, 'deepseek'],
  ]) {
    const out = join(f.dir, `guard-${name}.json`);
    const env = new Proxy({ REFLEXMESH_PROVIDER: provider }, { get(target, key) {
      if (key !== 'REFLEXMESH_PROVIDER') throw new Error('Credential or revision accessed');
      return target[key];
    } });
    await assert.rejects(evaluationMain(args(datasetPath, cap, out), sink(), { env,
      createProvider() { factoryCalls++; throw new Error('Provider constructed'); } }),
    /Evaluation plan mismatch/);
    assert.equal(existsSync(out), false);
  }
  assert.equal(factoryCalls, 0);
  const out = join(f.dir, 'guard-matched.json');
  assert.equal(await evaluationMain(args(join(f.dir, 'dataset.json'), 1, out), sink(), {
    env: { REFLEXMESH_PROVIDER: 'deepseek' },
    createProvider() { factoryCalls++; return fixtureDeployment('champion'); },
  }), 0);
  assert.equal(factoryCalls, 1);
  assert.equal(readEvaluationJson(out).rows[0].status, 'ok');
});
test('declared route guard binds model and revision without reading environment or credentials', async t => {
  const f = await fixtures(t);
  const basis = planEvaluation({ dataset: f.dataset, provider: 'deepseek', maxRequests: 1 });
  const route = { dataset: f.dataset, provider: 'deepseek', maxRequests: 1,
    modelId: 'deepseek-v4-flash', revision: 'evaluated-route-v1' };
  const planned = planEvaluation(route);
  assert.equal(planned.guardDigest, basis.guardDigest);
  assert.equal(basis.routeGuardDigest, undefined);
  assert.deepEqual(planned.declaredRoute, { providerId: 'deepseek/binary-json-estimate-v1',
    modelId: route.modelId, revision: route.revision });
  assert.match(planned.routeGuardDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(planned.routeGuardDigest, planEvaluation({ ...route, modelId: 'deepseek-v4-fast' }).routeGuardDigest);
  assert.notEqual(planned.routeGuardDigest, planEvaluation({ ...route, revision: 'evaluated-route-v2' }).routeGuardDigest);
  const jev = planEvaluation({ dataset: f.dataset, provider: 'jev', maxRequests: 1,
    modelId: 'jev-fixture', revision: route.revision });
  assert.equal(jev.declaredRoute.providerId, 'typesafe/jev');
  assert.notEqual(jev.routeGuardDigest, planned.routeGuardDigest);
  assert.throws(() => planEvaluation({ ...route, modelId: 'bad model' }), /valid evaluation model/);
  assert.throws(() => planEvaluation({ ...route, revision: 'bad\nrevision' }), /valid evaluation model/);
  const output = sink();
  assert.equal(await evaluationMain(['plan', '--dataset', join(f.dir, 'dataset.json'), '--provider', 'deepseek',
    '--max-requests', '1', '--model-id', route.modelId, '--provider-revision', route.revision], output, {
    env: new Proxy({}, { get() { throw new Error('Environment accessed'); } }),
    createProvider() { throw new Error('Provider constructed'); },
  }), 0);
  assert.match(output.text, /Declared route: "deepseek-v4-flash" @ "evaluated-route-v1"/);
  assert.match(output.text, /Route guard: [a-f0-9]{64}/);
});
test('route guard rejects drift before key access and freezes matching route through construction', async t => {
  const f = await fixtures(t), path = join(f.dir, 'dataset.json');
  const route = { dataset: f.dataset, provider: 'deepseek', maxRequests: 1,
    modelId: 'deepseek-v4-flash', revision: 'evaluated-route-v1' };
  const plan = planEvaluation(route), changed = structuredClone(f.dataset);
  changed.cases[0].state.observedKey = 'changed';
  const changedPath = join(f.dir, 'route-changed-dataset.json');
  writeFileSync(changedPath, JSON.stringify(changed));
  const args = (datasetPath, cap, out) => ['run', '--dataset', datasetPath, '--deployment-id', 'route-guarded-run',
    '--id', 'route-guarded-run-1', '--out', out, '--max-requests', String(cap), '--allow-remote',
    '--expect-route-plan-digest', plan.routeGuardDigest];
  let factoryCalls = 0;
  for (const [name, datasetPath, cap, provider, modelId, revision] of [
    ['dataset', changedPath, 1, 'deepseek', route.modelId, route.revision],
    ['provider', path, 1, 'jev', 'jev-model', route.revision],
    ['cap', path, 2, 'deepseek', route.modelId, route.revision],
    ['model', path, 1, 'deepseek', 'deepseek-v4-fast', route.revision],
    ['revision', path, 1, 'deepseek', route.modelId, 'evaluated-route-v2'],
  ]) {
    const out = join(f.dir, `route-${name}.json`);
    const env = new Proxy({ REFLEXMESH_PROVIDER: provider, DEEPSEEK_MODEL: modelId,
      TYPESAFE_MODEL: modelId, REFLEXMESH_PROVIDER_REVISION: revision }, { get(target, key) {
      if (!['REFLEXMESH_PROVIDER', 'DEEPSEEK_MODEL', 'TYPESAFE_MODEL', 'REFLEXMESH_PROVIDER_REVISION'].includes(key))
        throw new Error('Credential accessed');
      return target[key];
    } });
    await assert.rejects(evaluationMain(args(datasetPath, cap, out), sink(), { env,
      createProvider() { factoryCalls++; throw new Error('Provider constructed'); } }),
    /Evaluation route plan mismatch/);
    assert.equal(existsSync(out), false);
  }
  assert.equal(factoryCalls, 0);
  const out = join(f.dir, 'route-matched.json');
  let modelReads = 0;
  const env = new Proxy({ REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_PROVIDER_REVISION: route.revision }, {
    get(target, key) {
      if (key === 'DEEPSEEK_MODEL') { modelReads++; return modelReads === 1 ? route.modelId : 'changed-after-check'; }
      if (!['REFLEXMESH_PROVIDER', 'REFLEXMESH_PROVIDER_REVISION'].includes(key))
        throw new Error('Credential accessed');
      return target[key];
    },
  });
  const createProvider = selectedEnv => {
    factoryCalls++;
    assert.equal(selectedEnv.REFLEXMESH_PROVIDER, 'deepseek');
    assert.equal(selectedEnv.DEEPSEEK_MODEL, route.modelId);
    assert.equal(selectedEnv.REFLEXMESH_PROVIDER_REVISION, route.revision);
    const provider = { id: 'deepseek/binary-json-estimate-v1', model: route.modelId,
      capabilities: DEEPSEEK_ESTIMATE_CAPABILITIES,
      async evaluate() { return { model: route.modelId, answers: { match: { type: 'noul', noul: 0.8 } } }; } };
    return { provider, binding: { providerId: provider.id, modelId: route.modelId, revision: route.revision,
      calibrationRef: null, authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1' } };
  };
  assert.equal(await evaluationMain(args(path, 1, out), sink(), { env, createProvider }), 0);
  assert.equal(factoryCalls, 1);
  assert.equal(modelReads, 1);
  assert.equal(readEvaluationJson(out).rows[0].status, 'ok');
  const adapterOut = join(f.dir, 'route-adapter.json');
  let transportCalls = 0;
  assert.equal(await evaluationMain(args(path, 1, adapterOut), sink(), {
    env: { REFLEXMESH_ALLOW_REMOTE: 'true', REFLEXMESH_PROVIDER: 'deepseek',
      REFLEXMESH_PROVIDER_REVISION: route.revision, DEEPSEEK_MODEL: route.modelId,
      DEEPSEEK_API_KEY: 'offline-fixture-key' },
    createProvider: selectedEnv => createEvaluationProvider(selectedEnv, { fetch: async (_url, options) => {
      transportCalls++;
      assert.equal(JSON.parse(options.body).model, route.modelId);
      return Response.json({ object: 'chat.completion', model: route.modelId,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
          content: JSON.stringify({ answers: { match: { type: 'noul', noul: 0.8 } } }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } });
    } }),
  }), 0);
  assert.equal(transportCalls, 1);
  assert.equal(readEvaluationJson(adapterOut).rows[0].status, 'ok');
  const jevPlan = planEvaluation({ dataset: f.dataset, provider: 'jev', maxRequests: 1,
    modelId: 'jev-fixture', revision: route.revision });
  const jevOut = join(f.dir, 'route-jev.json');
  assert.equal(await evaluationMain(['run', '--dataset', path, '--deployment-id', 'jev-route',
    '--id', 'jev-route-1', '--out', jevOut, '--max-requests', '1', '--allow-remote',
    '--expect-route-plan-digest', jevPlan.routeGuardDigest], sink(), {
    env: { REFLEXMESH_PROVIDER: 'jev', TYPESAFE_MODEL: 'jev-fixture',
      REFLEXMESH_PROVIDER_REVISION: route.revision },
    createProvider() {
      const provider = { id: 'typesafe/jev', model: 'jev-fixture', capabilities: JEV_CAPABILITIES,
        async evaluate() { return { model: 'jev-fixture', answers: { match: { type: 'noul', noul: 0.8 } } }; } };
      return { provider, binding: { providerId: provider.id, modelId: provider.model, revision: route.revision,
        calibrationRef: null, authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1' } };
    },
  }), 0);
  assert.equal(readEvaluationJson(jevOut).rows[0].status, 'ok');
  const wrongOut = join(f.dir, 'route-wrong-binding.json');
  await assert.rejects(evaluationMain(args(path, 1, wrongOut), sink(), {
    env: { REFLEXMESH_PROVIDER: 'deepseek', DEEPSEEK_MODEL: route.modelId,
      REFLEXMESH_PROVIDER_REVISION: route.revision },
    createProvider() { return fixtureDeployment('champion'); },
  }), /Evaluation route binding mismatch/);
  assert.equal(existsSync(wrongOut), false);
});
test('wire guard rejects body and token drift before credentials, provider construction or output reservation', async t => {
  const f = await fixtures(t), path = join(f.dir, 'dataset.json');
  const route = { dataset: f.dataset, provider: 'deepseek', maxRequests: 1,
    modelId: 'test-model', revision: 'offline-v1', maxOutputTokens: 64 };
  const plan = planEvaluation(route);
  const args = (datasetPath, out, extra = []) => ['run', '--dataset', datasetPath,
    '--deployment-id', 'wire-run', '--id', 'wire-run-1', '--out', out,
    '--max-requests', '1', '--allow-remote', '--expect-wire-plan-digest', plan.wireGuardDigest, ...extra];
  const envValues = { REFLEXMESH_PROVIDER: 'deepseek', DEEPSEEK_MODEL: route.modelId,
    REFLEXMESH_PROVIDER_REVISION: route.revision };
  let factoryCalls = 0;
  const guardedEnv = new Proxy(envValues, { get(target, key) {
    if (!Object.hasOwn(target, key)) throw new Error('Credential accessed');
    return target[key];
  } });
  const noFactory = () => { factoryCalls++; throw new Error('Provider constructed'); };
  const capOut = join(f.dir, 'wire-cap-drift.json');
  await assert.rejects(evaluationMain(args(path, capOut), sink(), { env: guardedEnv, createProvider: noFactory }),
    /Evaluation wire plan mismatch/);
  assert.equal(existsSync(capOut), false);
  const reordered = structuredClone(f.dataset);
  for (const item of reordered.cases) item.state = Object.fromEntries(Object.entries(item.state).reverse());
  const reorderedPath = join(f.dir, 'wire-reordered.json');
  writeFileSync(reorderedPath, JSON.stringify(reordered));
  const orderOut = join(f.dir, 'wire-order-drift.json');
  await assert.rejects(evaluationMain(args(reorderedPath, orderOut, ['--max-output-tokens', '64']), sink(),
    { env: guardedEnv, createProvider: noFactory }), /Evaluation wire plan mismatch/);
  assert.equal(existsSync(orderOut), false);
  for (const [name, changed] of [
    ['provider', { REFLEXMESH_PROVIDER: 'jev', TYPESAFE_MODEL: 'test-model' }],
    ['model', { DEEPSEEK_MODEL: 'other-model' }],
    ['revision', { REFLEXMESH_PROVIDER_REVISION: 'other-revision' }],
  ]) {
    const changedOut = join(f.dir, `wire-${name}-drift.json`);
    await assert.rejects(evaluationMain(args(path, changedOut,
      name === 'provider' ? [] : ['--max-output-tokens', '64']), sink(), {
      env: new Proxy({ ...envValues, ...changed }, { get(target, key) {
        if (!Object.hasOwn(target, key)) throw new Error('Credential accessed');
        return target[key];
      } }), createProvider: noFactory,
    }), /Evaluation wire plan mismatch/);
    assert.equal(existsSync(changedOut), false);
  }
  assert.equal(factoryCalls, 0);
  let modelReads = 0, transportCalls = 0, sentBody;
  const changingEnv = new Proxy({ REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_PROVIDER_REVISION: route.revision,
    REFLEXMESH_ALLOW_REMOTE: 'true', DEEPSEEK_API_KEY: 'offline-fixture-key' }, { get(target, key) {
    if (key === 'DEEPSEEK_MODEL') { modelReads++; return modelReads === 1 ? route.modelId : 'changed-after-check'; }
    return target[key];
  } });
  const out = join(f.dir, 'wire-matched.json');
  const status = await evaluationMain(args(path, out, ['--max-output-tokens', '64']), sink(), {
    env: changingEnv, createProvider: (selectedEnv, options) => createEvaluationProvider(selectedEnv, {
      ...options, fetch: async (_url, request) => {
        transportCalls++; sentBody = request.body;
        assert.equal(JSON.parse(request.body).model, route.modelId);
        assert.equal(JSON.parse(request.body).max_tokens, 64);
        return Response.json({ object: 'chat.completion', model: route.modelId,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
            content: JSON.stringify({ answers: { match: { type: 'noul', noul: 0.8 } } }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } });
      },
    }),
  });
  assert.equal(status, 0);
  assert.equal(modelReads, 1);
  assert.equal(transportCalls, 1);
  assert.equal(sentBody, deepSeekRequestBody(route.modelId, f.dataset.cases[0].state,
    f.dataset.pack.questions, 64));
  assert.equal(readEvaluationJson(out).rows[0].status, 'ok');
});
test('Jev wire guard works alone or beside older guards without a token option', async t => {
  const f = await fixtures(t), path = join(f.dir, 'dataset.json'), out = join(f.dir, 'jev-wire.json');
  const plan = planEvaluation({ dataset: f.dataset, provider: 'jev', maxRequests: 1,
    modelId: 'jev-fixture', revision: 'offline-v1' });
  let calls = 0;
  const args = ['run', '--dataset', path, '--deployment-id', 'jev-wire', '--id', 'jev-wire-1',
    '--out', out, '--max-requests', '1', '--allow-remote', '--expect-plan-digest', plan.guardDigest,
    '--expect-route-plan-digest', plan.routeGuardDigest, '--expect-wire-plan-digest', plan.wireGuardDigest];
  assert.equal(await evaluationMain(args, sink(), {
    env: { REFLEXMESH_PROVIDER: 'jev', TYPESAFE_MODEL: 'jev-fixture',
      REFLEXMESH_PROVIDER_REVISION: 'offline-v1', REFLEXMESH_ALLOW_REMOTE: 'true', TYPESAFE_API_KEY: 'offline-fixture-key' },
    createProvider: (env, options) => createEvaluationProvider(env, { ...options, fetch: async () => {
      calls++; return Response.json({ model: 'jev-fixture', answers: { match: { type: 'noul', noul: 0.8 } } });
    } }),
  }), 0);
  assert.equal(calls, 1);
  assert.equal(readEvaluationJson(out).rows[0].status, 'ok');
  const rejectedOut = join(f.dir, 'jev-wire-token.json');
  await assert.rejects(evaluationMain([...args.map(value => value === out ? rejectedOut : value),
    '--max-output-tokens', '64'], sink(), {
    env: { REFLEXMESH_PROVIDER: 'jev', TYPESAFE_MODEL: 'jev-fixture', REFLEXMESH_PROVIDER_REVISION: 'offline-v1' },
    createProvider() { throw new Error('Provider constructed'); },
  }), /DeepSeek output token limit requires a declared route/);
  assert.equal(existsSync(rejectedOut), false);
});
test('opt-in account catalog blocks stale routes before evaluation and pins the checked key', async t => {
  const f = await fixtures(t), path = join(f.dir, 'dataset.json');
  const route = { dataset: f.dataset, provider: 'deepseek', maxRequests: 1,
    modelId: 'deepseek-v4-flash', revision: 'offline-v1' };
  const plan = planEvaluation(route);
  const args = out => ['run', '--dataset', path, '--deployment-id', 'catalog-run', '--id', 'catalog-run-1',
    '--out', out, '--max-requests', '1', '--allow-remote', '--expect-route-plan-digest', plan.routeGuardDigest,
    '--require-listed-model'];
  const values = { REFLEXMESH_ALLOW_REMOTE: 'true', REFLEXMESH_PROVIDER: 'deepseek',
    REFLEXMESH_PROVIDER_REVISION: route.revision, DEEPSEEK_MODEL: route.modelId };
  let factoryCalls = 0, catalogCalls = 0;
  const staleOut = join(f.dir, 'catalog-stale.json');
  await assert.rejects(evaluationMain(args(staleOut), sink(), {
    env: { ...values, DEEPSEEK_API_KEY: 'private-fixture-key' },
    modelCatalogFetch: async () => { catalogCalls++; return Response.json({ object: 'list',
      data: [{ id: 'deepseek-flash', object: 'model' }] }); },
    createProvider() { factoryCalls++; throw new Error('Provider must not be constructed'); },
  }), /not listed/);
  assert.equal(catalogCalls, 1); assert.equal(factoryCalls, 0); assert.equal(existsSync(staleOut), false);
  const disabledOut = join(f.dir, 'catalog-disabled.json');
  await assert.rejects(evaluationMain(args(disabledOut), sink(), {
    env: { ...values, REFLEXMESH_ALLOW_REMOTE: 'false', DEEPSEEK_API_KEY: 'private-fixture-key' },
    modelCatalogFetch() { catalogCalls++; throw new Error('No remote opt-in'); },
  }), /not enabled/);
  assert.equal(catalogCalls, 1); assert.equal(existsSync(disabledOut), false);
  const changed = structuredClone(f.dataset); changed.cases[0].state.observedKey = 'drift';
  const changedPath = join(f.dir, 'catalog-changed.json'); writeFileSync(changedPath, JSON.stringify(changed));
  const driftOut = join(f.dir, 'catalog-drift-output.json');
  await assert.rejects(evaluationMain(args(driftOut).map(x => x === path ? changedPath : x), sink(), {
    env: new Proxy(values, { get(target, key) {
      if (key === 'DEEPSEEK_API_KEY') throw new Error('Key read before route guard');
      return target[key];
    } }), modelCatalogFetch() { catalogCalls++; throw new Error('Catalog before guard'); },
  }), /route plan mismatch/);
  assert.equal(catalogCalls, 1); assert.equal(existsSync(driftOut), false);
  const jevPlan = planEvaluation({ dataset: f.dataset, provider: 'jev', maxRequests: 1,
    modelId: 'jev-model', revision: 'offline-v1' });
  const jevOut = join(f.dir, 'catalog-jev.json');
  await assert.rejects(evaluationMain(['run', '--dataset', path, '--deployment-id', 'jev-catalog',
    '--id', 'jev-catalog-1', '--out', jevOut, '--max-requests', '1', '--allow-remote',
    '--expect-route-plan-digest', jevPlan.routeGuardDigest, '--require-listed-model'], sink(), {
    env: { REFLEXMESH_PROVIDER: 'jev', TYPESAFE_MODEL: 'jev-model', REFLEXMESH_PROVIDER_REVISION: 'offline-v1' },
    modelCatalogFetch() { catalogCalls++; throw new Error('Wrong provider'); },
  }), /DeepSeek only/);
  assert.equal(catalogCalls, 1); assert.equal(existsSync(jevOut), false);
  const canonicalRoute = { ...route, modelId: 'deepseek-flash' }, canonicalPlan = planEvaluation(canonicalRoute);
  const matchedOut = join(f.dir, 'catalog-matched.json');
  const matchedArgs = args(matchedOut).map(x => x === plan.routeGuardDigest ? canonicalPlan.routeGuardDigest : x);
  let keyReads = 0, completionCalls = 0;
  const changingEnv = new Proxy({ ...values, DEEPSEEK_MODEL: canonicalRoute.modelId }, { get(target, key) {
    if (key === 'DEEPSEEK_API_KEY') { keyReads++; return keyReads === 1 ? 'first-private-key' : 'changed-private-key'; }
    return target[key];
  } });
  const output = sink();
  assert.equal(await evaluationMain(matchedArgs, output, {
    env: changingEnv,
    modelCatalogFetch: async (_url, request) => {
      catalogCalls++;
      assert.equal(request.headers.Authorization, 'Bearer first-private-key');
      return Response.json({ object: 'list', data: [{ id: canonicalRoute.modelId, object: 'model' }] });
    },
    createProvider: (selectedEnv, options) => {
      factoryCalls++;
      assert.equal(selectedEnv.DEEPSEEK_API_KEY, 'first-private-key');
      return createEvaluationProvider(selectedEnv, { ...options, fetch: async () => {
        completionCalls++;
        return Response.json({ object: 'chat.completion', model: canonicalRoute.modelId,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
            content: JSON.stringify({ answers: { match: { type: 'noul', noul: 0.8 } } }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } });
      } });
    },
  }), 0);
  assert.equal(catalogCalls, 2); assert.equal(factoryCalls, 1); assert.equal(completionCalls, 1);
  assert.equal(keyReads, 1); assert.equal(readEvaluationJson(matchedOut).rows[0].status, 'ok');
  assert.equal(output.text.includes('private-key'), false);
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
