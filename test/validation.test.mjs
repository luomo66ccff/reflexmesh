import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, validateResult, validatePack, evaluatePolicy, memoryAdmissionPack, toolPreflightPack, calibrationReport, planSpeculation } from '../dist/index.js';

const q = { route: { type: 'choice', instructions: 'Select route.', criteria: { a: 'A', b: 'B' } }, risk: { type: 'score', instructions: 'Score.', criteria: ['low', 'high'] }, ok: { type: 'noul', instructions: 'Is it OK?' } };
const response = () => ({ model: 'test', answers: { route: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, risk: { type: 'score', score: 0.3, confidence: 0.6, probabilities: { '0': 0.7, '1': 0.3 } }, ok: { type: 'noul', noul: 0.9 } } });
test('all three primitives validate; expected score can be fractional', () => { assert.equal(validateResult(q, response()).answers.risk.score, 0.3); });
test('choice outside declared labels is rejected', () => { const r = response(); r.answers.route.choice = 'c'; assert.throws(() => validateResult(q, r), /selected label/); });
test('probability sum and label coverage are enforced', () => {
  const r = response(); r.answers.route.probabilities.b = 0.4; assert.throws(() => validateResult(q, r), /sum to one/);
  r.answers.route.probabilities = { a: 0.8, c: 0.2 }; assert.throws(() => validateResult(q, r), /label mismatch/);
});
test('missing and additional answers fail closed', () => {
  const r = response(); delete r.answers.ok; assert.throws(() => validateResult(q, r), /count mismatch/);
  r.answers.extra = { type: 'noul', noul: 1 }; assert.throws(() => validateResult(q, r), /Missing answer/);
});
test('score must match distribution expectation', () => { const r = response(); r.answers.risk.score = 0.9; assert.throws(() => validateResult(q, r), /expectation/); });
test('NaN confidence and negative usage are rejected', () => {
  const r = response(); r.answers.route.confidence = NaN; assert.throws(() => validateResult(q, r), /probability/);
  r.answers.route.confidence = 0.8; r.usage = { inputTokens: -1, outputTokens: 0 }; assert.throws(() => validateResult(q, r), /token usage/);
});
test('canonical form sorts keys but rejects cycles, accessors and non-finite values', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.throws(() => canonical({ x: Infinity }));
  const x = {}; x.x = x; assert.throws(() => canonical(x), /Cyclic/);
  assert.throws(() => canonical({ get x() { throw new Error('must not execute getter'); } }), /accessor/);
});
test('unsafe fallback, unknown references and unconditional allow are rejected', () => {
  const p = structuredClone(toolPreflightPack); p.fallback = 'allow'; assert.throws(() => validatePack(p), /fallback/);
  p.fallback = 'escalate'; p.rules[0].all[0].answer = 'missing'; assert.throws(() => validatePack(p), /Unknown question/);
  p.rules[0].all = []; assert.throws(() => validatePack(p), /Unconditional/);
});
test('memory admission distinguishes stable, temporary, sensitive and conflicting candidates', () => {
  validatePack(memoryAdmissionPack);
  const a = Object.fromEntries(['useful', 'stable', 'sensitive', 'conflict', 'duplicate'].map(k => [k, { type: 'noul', noul: ['useful', 'stable'].includes(k) ? 0.95 : 0.01 }]));
  assert.equal(evaluatePolicy(memoryAdmissionPack, a).directive, 'propose_persist');
  a.stable.noul = 0.1; assert.equal(evaluatePolicy(memoryAdmissionPack, a).directive, 'propose_ttl');
  a.sensitive.noul = 0.8; assert.equal(evaluatePolicy(memoryAdmissionPack, a).effect, 'confirm');
  a.sensitive.noul = 0.01; a.conflict.noul = 0.5; assert.equal(evaluatePolicy(memoryAdmissionPack, a).effect, 'escalate');
});
test('calibration calculates Brier/ECE from explicit labels without adjusting policy', () => {
  const report = calibrationReport([{ probability: 0.1, label: 0 }, { probability: 0.9, label: 1 }]);
  assert.ok(Math.abs(report.brier - 0.01) < 1e-12); assert.ok(Math.abs(report.ece - 0.1) < 1e-12);
  assert.throws(() => calibrationReport([])); assert.throws(() => calibrationReport([{ probability: 0.5, label: 2 }]));
});
const candidate = (overrides = {}) => ({ id: 'read', probability: 0.8, latencySavedMs: 200, costUsd: 0.0001, riskPenaltyUsd: 0, effect: 'read', idempotent: true, speculatable: true, authorized: true, sensitive: false, ...overrides });
const budget = { budgetUsd: 0.001, latencyValueUsdPerMs: 0.00001, maxParallel: 2 };
test('speculation is a budgeted planner and excludes writes, sensitive or unauthorized reads', () => {
  const plan = planSpeculation([candidate(), candidate({ id: 'write', effect: 'write' }), candidate({ id: 'sensitive', sensitive: true }), candidate({ id: 'no-auth', authorized: false })], budget);
  assert.deepEqual(plan.map(c => c.id), ['read']);
});
test('speculation rejects invalid inputs and respects cost/parallel limits', () => {
  assert.throws(() => planSpeculation([candidate({ probability: NaN })], budget));
  assert.throws(() => planSpeculation([candidate(), candidate()], budget), /Duplicate/);
  assert.equal(planSpeculation([candidate()], { ...budget, budgetUsd: 0 }).length, 0);
  assert.equal(planSpeculation([candidate()], { ...budget, maxParallel: 0 }).length, 0);
});
