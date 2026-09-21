import test from 'node:test';
import assert from 'node:assert/strict';
import { JevProvider, DeepSeekEstimateProvider, ReflexMesh, MemoryLedger } from '../dist/index.js';

const cases = {
  noul: { question: { type: 'noul', instructions: 'Is the synthetic input present?' }, answer: { type: 'noul', noul: 0.72 } },
  choice: { question: { type: 'choice', instructions: 'Choose a synthetic label.', criteria: { yes: 'yes', no: 'no' } },
    answer: { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.72, no: 0.28 } } },
  score: { question: { type: 'score', instructions: 'Score a synthetic input.', criteria: ['low', 'high'] },
    answer: { type: 'score', score: 0.72, confidence: 0.8, probabilities: { 0: 0.28, 1: 0.72 } } },
};
const binary = { q: cases.noul.question };
const base = () => ({ model: 'fixture-model', answers: { q: structuredClone(cases.noul.answer) }, usage: { inputTokens: 7, outputTokens: 9 } });
const pack = question => ({ id: 'conformance', version: '1', eventType: 'fixture.request', questions: { q: question }, rules: [], fallback: 'escalate' });
const event = state => ({ id: 'conformance', source: 'fixture', tenantId: 'fixture', type: 'fixture.request', time: '2026-09-22T00:00:00Z', state });
const specs = [
  { name: 'Jev', make: fetch => new JevProvider({ apiKey: 'OFFLINE_KEY', model: 'fixture-model', fetch }),
    wire: r => ({ model: r.model, answers: r.answers, usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens } }) },
  { name: 'DeepSeek independent JSON estimate', make: fetch => new DeepSeekEstimateProvider({ apiKey: 'OFFLINE_KEY', model: 'fixture-model', fetch }),
    wire: r => ({ object: 'chat.completion', model: r.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers: r.answers }) } }],
      usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens } }) },
];

// Same conformance assertions for each transport; only wire encoding/constructor differs.
for (const spec of specs) {
  for (const [kind, example] of Object.entries(cases)) test(`${spec.name}: declared ${kind} roundtrip or zero-egress rejection`, async () => {
    let calls = 0;
    const value = base(); value.answers.q = example.answer;
    const p = spec.make(async () => { calls++; return Response.json(spec.wire(value)); });
    if (p.capabilities.answers[kind] === 'unsupported') {
      await assert.rejects(p.evaluate({}, { q: example.question }, new AbortController().signal)); assert.equal(calls, 0);
    } else {
      const result = await p.evaluate({}, { q: example.question }, new AbortController().signal);
      assert.deepEqual(result.answers.q, example.answer); assert.deepEqual(result.usage, value.usage); assert.equal(calls, 1);
    }
  });
  for (const [name, alter] of [
    ['missing answer', r => { delete r.answers.q; }],
    ['extra answer', r => { r.answers.extra = r.answers.q; }],
    ['wrong answer type', r => { r.answers.q = { type: 'choice', choice: 'yes' }; }],
    ['string numeric value', r => { r.answers.q.noul = '0.9'; }],
    ['out-of-range value', r => { r.answers.q.noul = -0.1; }],
    ['wrong model', r => { r.model = 'different'; }],
  ]) test(`${spec.name}: ${name} is rejected without retry`, async () => {
    let calls = 0; const value = base(); alter(value);
    const p = spec.make(async () => { calls++; return Response.json(spec.wire(value)); });
    await assert.rejects(p.evaluate({}, binary, new AbortController().signal)); assert.equal(calls, 1);
  });
  test(`${spec.name}: own state/question limits and pre-abort have zero egress`, async () => {
    let calls = 0; const p = spec.make(async () => { calls++; return Response.json(spec.wire(base())); });
    await assert.rejects(p.evaluate('x'.repeat(p.capabilities.limits.maxStateBytes + 1), binary, new AbortController().signal));
    const questions = Object.fromEntries(Array.from({ length: p.capabilities.limits.maxQuestions + 1 }, (_, i) => [`q${i}`, cases.noul.question]));
    await assert.rejects(p.evaluate({}, questions, new AbortController().signal));
    const controller = new AbortController(); controller.abort(); await assert.rejects(p.evaluate({}, binary, controller.signal));
    assert.equal(calls, 0);
  });
  test(`${spec.name}: serialization hooks and accessors cannot change validated wire input`, async () => {
    let calls = 0, hooks = 0;
    const p = spec.make(async () => { calls++; return Response.json(spec.wire(base())); });
    const hooked = { ...cases.noul.question, toJSON() { hooks++; return cases.choice.question; } };
    const getter = { instructions: 'synthetic', get type() { hooks++; return 'noul'; } };
    const array = []; array.toJSON = () => { hooks++; return { hidden: 'x'.repeat(17000) }; };
    const indexed = []; Object.defineProperty(indexed, '0', { enumerable: true, get() { hooks++; return 'synthetic'; } });
    const hidden = Object.defineProperties({}, { type: { value: 'noul' }, instructions: { value: 'synthetic' } });
    for (const [state, questions] of [[{}, { q: hooked }], [{}, { q: getter }], [{}, { q: hidden }], [array, binary], [indexed, binary]])
      await assert.rejects(p.evaluate(state, questions, new AbortController().signal));
    assert.equal(calls, 0); assert.equal(hooks, 0);
  });
  for (const [kind, name, alter] of [
    ['choice', 'missing confidence', a => { delete a.confidence; }],
    ['choice', 'wrong distribution labels', a => { a.probabilities = { yes: 0.7, other: 0.3 }; }],
    ['choice', 'non-unit probability mass', a => { a.probabilities = { yes: 0.7, no: 0.7 }; }],
    ['score', 'missing confidence', a => { delete a.confidence; }],
    ['score', 'inconsistent expected score', a => { a.score = 0.1; }],
    ['score', 'non-finite score', a => { a.score = Infinity; }],
  ]) test(`${spec.name}: ${kind} ${name} rejects without conversion`, async () => {
    let calls = 0; const value = base(); value.answers.q = structuredClone(cases[kind].answer); alter(value.answers.q);
    const p = spec.make(async () => { calls++; return Response.json(spec.wire(value)); });
    await assert.rejects(p.evaluate({}, { q: cases[kind].question }, new AbortController().signal));
    assert.equal(calls, p.capabilities.answers[kind] === 'unsupported' ? 0 : 1);
  });
  test(`${spec.name}: final action-wrapped state is gated before evaluation`, async () => {
    let calls = 0; const p = spec.make(async () => { calls++; return Response.json(spec.wire(base())); });
    const mesh = new ReflexMesh({ provider: p, ledger: new MemoryLedger(), maxEventBytes: 2000000 }).registerPack(pack(cases.noul.question));
    const result = await mesh.run(event({}), { packId: 'conformance', action: { toolId: 'fixture', args: { text: '界'.repeat(Math.ceil(p.capabilities.limits.maxStateBytes / 3)) } } });
    assert.equal(result.verdict.effect, 'escalate'); assert.equal(result.provider, undefined); assert.equal(calls, 0);
  });
  test(`${spec.name}: cancellation during fetch propagates without fallback`, async () => {
    let calls = 0, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const controller = new AbortController();
    const p = spec.make(async (_url, init) => { calls++; entered(); return await new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); });
    const promise = p.evaluate({}, binary, controller.signal); await ready; controller.abort(); await assert.rejects(promise); assert.equal(calls, 1);
  });
  test(`${spec.name}: runtime failure escalates without provider fallback`, async () => {
    let calls = 0; const p = spec.make(async () => { calls++; return new Response('PRIVATE_PROVIDER_BODY', { status: 503 }); });
    const mesh = new ReflexMesh({ provider: p, ledger: new MemoryLedger() }).registerPack(pack(cases.noul.question));
    const result = await mesh.run(event({}), { packId: 'conformance' });
    assert.equal(result.status, 'shadow'); assert.equal(result.verdict.effect, 'escalate'); assert.equal(result.provider, undefined);
    assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
}
