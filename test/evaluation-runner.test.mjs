import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../dist/index.js';
import { runEvaluation } from '../adapters/evaluation-runner.mjs';
import { createEvaluationProvider } from '../adapters/evaluation-provider.mjs';
import { comparisonFixture } from '../examples/evaluation-fixture.mjs';

const answer = () => ({ model: 'test-model', answers: { match: { type: 'noul', noul: 0.6 } } });
function setup(evaluate = answer, overrides = {}) {
  const provider = { id: 'test-provider', model: 'test-model', capabilities: new MockProvider(answer).capabilities, evaluate, ...overrides };
  return { dataset: comparisonFixture().dataset, provider, deploymentId: 'test-deploy', id: 'test-run', maxRequests: 4,
    binding: { providerId: provider.id, modelId: provider.model, revision: 'test-v1', calibrationRef: null,
      authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1' } };
}
test('evaluation request budget retains every case and supplies only immutable state/questions/signal', async () => {
  let calls = 0;
  const options = setup((...args) => {
    calls++; assert.equal(args.length, 3); const [state, questions, signal] = args;
    assert.deepEqual(Object.keys(state).sort(), ['observedKey', 'requestedKey']);
    assert.equal(Object.isFrozen(state), true); assert.equal(Object.isFrozen(questions), true);
    assert.equal(signal.aborted, false); return answer();
  });
  const result = await runEvaluation({ ...options, maxRequests: 2 });
  assert.equal(calls, 2); assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map(row => row.status), ['ok', 'ok', 'not_attempted', 'not_attempted']);
  assert.equal(result.rows[2].reasonCode, 'budget_exhausted'); assert.equal(Object.isFrozen(result.rows), true);
  assert.equal(JSON.stringify(result).includes('test-oracle'), false);
});
test('unsupported full question contract and oversized cases never invoke provider or drop questions', async () => {
  let calls = 0;
  const options = setup(() => { calls++; return answer(); });
  const dataset = structuredClone(options.dataset);
  dataset.pack.questions.route = { type: 'choice', instructions: 'Route?', criteria: { a: 'A', b: 'B' } };
  options.provider.capabilities = { ...options.provider.capabilities, answers: { ...options.provider.capabilities.answers, choice: 'unsupported' } };
  const result = await runEvaluation({ ...options, dataset });
  assert.equal(calls, 0); assert.ok(result.rows.every(row => row.status === 'unsupported'));
  options.provider.capabilities = { ...options.provider.capabilities, limits: { ...options.provider.capabilities.limits, maxStateBytes: 1 } };
  assert.ok((await runEvaluation(options)).rows.every(row => row.reasonCode === 'input_incompatible'));
  assert.equal(calls, 0);
});
test('unsupported input does not spend invocation budget for later supported cases', async () => {
  let calls = 0;
  const options = setup(() => { calls++; return answer(); });
  const dataset = structuredClone(options.dataset); dataset.cases[0].state = 'x'.repeat(100);
  options.provider.capabilities = { ...options.provider.capabilities, limits: { ...options.provider.capabilities.limits, maxStateBytes: 80 } };
  const result = await runEvaluation({ ...options, dataset, maxRequests: 1 });
  assert.equal(calls, 1); assert.deepEqual(result.rows.map(row => row.status), ['unsupported', 'ok', 'not_attempted', 'not_attempted']);
});
test('provider rejection stops remaining calls and never persists private error text', async () => {
  let calls = 0; const result = await runEvaluation(setup(() => { calls++; throw new Error('PRIVATE_PROVIDER_ERROR'); }));
  assert.equal(calls, 1); assert.equal(result.rows[0].reasonCode, 'provider_error');
  assert.ok(result.rows.slice(1).every(row => row.reasonCode === 'stopped_after_failure'));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('ignored-abort timeout returns bounded failure; late success cannot mutate receipt or trigger another call', async () => {
  let resolveLate, calls = 0, providerSignal;
  const result = await runEvaluation({ ...setup((_state, _questions, signal) => {
    calls++; providerSignal = signal; return new Promise(resolve => { resolveLate = resolve; });
  }), timeoutMs: 15 });
  const before = JSON.stringify(result);
  assert.equal(providerSignal.aborted, true); assert.equal(result.rows[0].reasonCode, 'deadline_exceeded');
  resolveLate(answer()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(JSON.stringify(result), before);
});
test('pre-aborted evaluation has zero calls; in-flight cancellation stops subsequent cases', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const first = await runEvaluation({ ...setup(() => { calls++; return answer(); }), signal: controller.signal });
  assert.equal(calls, 0); assert.ok(first.rows.every(row => row.status === 'not_attempted' && row.reasonCode === 'cancelled'));
  const inflight = new AbortController();
  const second = await runEvaluation({ ...setup(() => { calls++; inflight.abort(); return new Promise(() => {}); }), signal: inflight.signal });
  assert.equal(calls, 1); assert.equal(second.rows[0].status, 'failed');
  assert.ok(second.rows.every(row => row.reasonCode === 'cancelled'));
});
test('invalid budgets, identities, capabilities and execution bindings fail before first invocation', async () => {
  let calls = 0; const options = setup(() => { calls++; return answer(); });
  for (const changed of [{ maxRequests: 0 }, { maxRequests: 1001 }, { timeoutMs: Infinity }, { timeoutMs: 0 },
    { deploymentId: 'bad id' }, { id: '' }, { binding: null }, { signal: { aborted: false } },
    { binding: { ...options.binding, modelId: 'different' } },
    { binding: { ...options.binding, authorizationRevision: 'execution-authorized' } },
    { binding: { ...options.binding, calibrationRef: 'not-independent' } }]) await assert.rejects(runEvaluation({ ...options, ...changed }));
  assert.equal(calls, 0);
});
test('malformed, extra-field and wrong-model results become failed rows with no repair', async () => {
  for (const mutate of [r => { r.model = 'other'; }, r => { r.extra = true; }, r => { r.answers.match.extra = true; },
    r => { r.answers.match.noul = 2; }, r => { delete r.answers.match; }]) {
    let calls = 0; const result = await runEvaluation(setup(() => { calls++; const raw = answer(); mutate(raw); return raw; }));
    assert.equal(calls, 1); assert.equal(result.rows[0].reasonCode, 'provider_error');
  }
});
test('evaluation factory needs explicit egress, route, revision and credentials with no construction egress', () => {
  let calls = 0; const fetch = () => { calls++; throw new Error('No network'); };
  const env = { REFLEXMESH_ALLOW_REMOTE: 'true', REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_PROVIDER_REVISION: 'test-v1',
    DEEPSEEK_API_KEY: 'synthetic-key', DEEPSEEK_MODEL: 'test-model' };
  for (const name of Object.keys(env)) { const missing = { ...env }; delete missing[name]; assert.throws(() => createEvaluationProvider(missing, { fetch })); }
  const selected = createEvaluationProvider(env, { fetch, maxOutputTokens: 64 });
  assert.equal(selected.binding.modelId, 'test-model'); assert.equal(selected.binding.authorizationRevision, 'eval-no-execution-v1');
  const jev = { ...env, REFLEXMESH_PROVIDER: 'jev', TYPESAFE_API_KEY: 'synthetic-key', TYPESAFE_MODEL: 'test-jev' };
  assert.equal(createEvaluationProvider(jev, { fetch }).binding.modelId, 'test-jev');
  assert.throws(() => createEvaluationProvider(jev, { fetch, maxOutputTokens: 64 }));
  assert.equal(calls, 0);
});
test('real DeepSeek adapter wire has no label envelope, tools or host context (offline transport)', async () => {
  let calls = 0;
  const selected = createEvaluationProvider({ REFLEXMESH_ALLOW_REMOTE: 'true', REFLEXMESH_PROVIDER: 'deepseek',
    REFLEXMESH_PROVIDER_REVISION: 'offline-v1', DEEPSEEK_API_KEY: 'synthetic-key', DEEPSEEK_MODEL: 'test-model' }, {
    fetch: async (url, options) => {
      calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body), envelope = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(envelope).sort(), ['questions', 'state']); assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.equal(options.body.includes('test-oracle'), false); assert.equal(body.max_tokens, 64);
      return new Response(JSON.stringify({ object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers: answer().answers }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } }));
    }, maxOutputTokens: 64,
  });
  const result = await runEvaluation({ ...setup(), ...selected, maxRequests: 1 });
  assert.equal(calls, 1); assert.equal(result.origin, 'provider-run'); assert.equal(result.rows[0].status, 'ok');
  assert.equal(result.deployment.capabilities.probabilitySemantics, 'elicited-estimate');
});
test('shipped provider wire limits skip an unsendable case without consuming the request cap', async () => {
  for (const [providerName, instructionBytes, stateBytes] of [
    ['deepseek', 28000, 5000], ['jev', 250000, 10000],
  ]) {
    let calls = 0;
    const dataset = structuredClone(comparisonFixture().dataset);
    dataset.pack.questions.match.instructions = 'q'.repeat(instructionBytes);
    dataset.cases[0].state = { blob: 's'.repeat(stateBytes) };
    const env = { REFLEXMESH_ALLOW_REMOTE: 'true', REFLEXMESH_PROVIDER: providerName,
      REFLEXMESH_PROVIDER_REVISION: 'offline-v1',
      ...(providerName === 'deepseek' ? { DEEPSEEK_API_KEY: 'synthetic-key', DEEPSEEK_MODEL: 'test-model' }
        : { TYPESAFE_API_KEY: 'synthetic-key', TYPESAFE_MODEL: 'test-model' }) };
    const selected = createEvaluationProvider(env, { fetch: async () => {
      calls++;
      return new Response(JSON.stringify(providerName === 'deepseek'
        ? { object: 'chat.completion', model: 'test-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers: answer().answers }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } }
        : answer()));
    } });
    const result = await runEvaluation({ ...setup(), ...selected, dataset, maxRequests: 1 });
    assert.equal(calls, 1, providerName);
    assert.deepEqual(result.rows.map(row => row.status),
      ['unsupported', 'ok', 'not_attempted', 'not_attempted'], providerName);
    assert.equal(result.rows[0].reasonCode, 'input_incompatible', providerName);
    assert.equal(result.rows[2].reasonCode, 'budget_exhausted', providerName);
    const allOversized = structuredClone(dataset);
    for (const item of allOversized.cases) item.state = { blob: 's'.repeat(stateBytes) };
    const allResult = await runEvaluation({ ...setup(), ...selected, dataset: allOversized, maxRequests: 1 });
    assert.equal(calls, 1, providerName);
    assert.ok(allResult.rows.every(row => row.status === 'unsupported' && row.reasonCode === 'input_incompatible'), providerName);
  }
});
