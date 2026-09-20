import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { event } from './helpers.mjs';
const pack = { id: 'labels', version: '1', eventType: 'label.test', rules: [], fallback: 'escalate', questions: {
  binary: { type: 'noul', instructions: 'Binary target' },
  choice: { type: 'choice', instructions: 'Choice target', criteria: { a: 'A', b: 'B' } },
  ordinal: { type: 'score', instructions: 'Ordinal target', criteria: ['low','medium','high'] },
} };
const result = { model: 'fixture', answers: {
  binary: { type: 'noul', noul: 0.8 },
  choice: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
  ordinal: { type: 'score', score: 0.7, confidence: 0.6, probabilities: { '0': 0.5, '1': 0.3, '2': 0.2 } },
} };
async function setup(t) {
  const k = new SqliteKernel(':memory:'); t.after(() => k.close());
  const mesh = new DurableMesh({ kernel: k, provider: new MockProvider(() => result),
    binding: { providerId: 'mock', modelId: 'fixture', revision: '1', authorizationRevision: '1', toolsetRevision: '1' },
  }).registerPack(pack);
  const e = event({ type: 'label.test' }); await mesh.run(e, { packId: 'labels' }); return { k, key: eventKey(e) };
}
const label = (questionId, value, id = questionId) => ({ id, questionId, value, sourceRef: 'fixture:independent-target', provenance: 'test-oracle' });

test('typed ground-truth labels accept binary classes, declared choices and ordinal indices', async t => {
  const { k, key } = await setup(t);
  for (const [q,v] of [['binary',0],['binary',1],['choice','a'],['choice','b'],['ordinal',0],['ordinal',2]]) k.addLabel(key, label(q,v,`${q}-${v}`));
  assert.equal(k.inspect(key).labels.length, 6);
});
test('binary probabilities, strings and boolean labels cannot pollute calibration targets', async t => {
  const { k, key } = await setup(t);
  for (const value of [0.8,'1',true,null,-1,2]) assert.throws(() => k.addLabel(key,label('binary',value)), /Binary label/);
  assert.equal(k.inspect(key).labels.length, 0);
});
test('choice labels must be declared own keys; ordinal targets cannot be fractional', async t => {
  const { k, key } = await setup(t);
  for (const value of ['c','constructor','__proto__',0]) assert.throws(() => k.addLabel(key,label('choice',value)), /choice label/);
  for (const value of [0.7,-1,3,'1',false]) assert.throws(() => k.addLabel(key,label('ordinal',value)), /rubric index/);
});
test('inherited properties such as constructor are not predicted questions', async t => {
  const { k, key } = await setup(t);
  for (const name of ['constructor','toString','__proto__','not-predicted']) assert.throws(() => k.addLabel(key,label(name,1)), /No completed prediction/);
  assert.equal(k.inspect(key).labels.length, 0);
});
test('labels reject extra raw data and model-provided truth provenance', async t => {
  const { k, key } = await setup(t), v = label('binary',1);
  assert.throws(() => k.addLabel(key,{ ...v, transcript: 'SECRET' }), /fields/);
  assert.throws(() => k.addLabel(key,{ ...v, provenance: 'model-reported' }), /provenance/);
  let getterRuns = 0;
  assert.throws(() => k.addLabel(key,{ ...v, get value() { getterRuns++; return 1; } }), /accessor/);
  assert.equal(getterRuns, 0);
});
test('identical labels stay idempotent; contradictory reuse of an ID conflicts', async t => {
  const { k, key } = await setup(t); k.addLabel(key,label('binary',1)); k.addLabel(key,label('binary',1));
  assert.equal(k.inspect(key).labels.length, 1);
  assert.throws(() => k.addLabel(key,label('binary',0)), /Label conflict/);
});
