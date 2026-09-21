import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../dist/index.js';
import {
  validateEvaluationDataset, evaluationDatasetDigest, evaluationCaseDigest,
  validateEvaluationLabels, validateEvaluationPredictions, evaluationDeploymentDigest,
} from '../adapters/evaluation-contract.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const pack = () => ({ id: 'compare-pack', version: 'v1', eventType: 'evaluation.case',
  questions: { binary: { type: 'noul', instructions: 'Risk?' },
    choice: { type: 'choice', instructions: 'Route?', criteria: { a: 'A', b: 'B' } },
    score: { type: 'score', instructions: 'Level?', criteria: ['low', 'high', 'critical'] } },
  rules: [{ id: 'high-risk', all: [{ answer: 'binary', metric: 'value', op: 'gte', value: 0.5 }], effect: 'deny' }],
  fallback: 'confirm' });
const dataset = () => ({ schemaVersion: 1, kind: 'reflexmesh-dataset', id: 'dataset-v1', revision: 'rev1',
  populationRef: 'local-synthetic-cases', dataKind: 'synthetic', pack: pack(),
  cases: [{ id: 'c1', state: { note: 'one' } }, { id: 'c2', state: { note: 'two' } }] });
const labels = data => ({ schemaVersion: 1, kind: 'reflexmesh-labelset', id: 'labels-v1', revision: 'rev1',
  datasetDigest: evaluationDatasetDigest(data), independence: 'operator-asserted-independent',
  labels: [{ caseId: 'c1', label: { id: 'l1', questionId: 'binary', value: 1, provenance: 'test-oracle', sourceRef: 'fixture' } }] });
const capabilities = () => ({ schemaVersion: 1, resultContract: 'probabilistic-v1', probabilitySemantics: 'synthetic-fixture',
  answers: { noul: 'probability', choice: 'distribution-with-confidence', score: 'distribution-with-confidence-and-expected-value' },
  limits: { maxStateBytes: 1024, maxQuestions: 3, maxChoicesPerQuestion: 3 } });
const deployment = () => { const caps = capabilities(); return { id: 'deploy-a',
  binding: { providerId: 'fixture', modelId: 'model-a', revision: 'rev1', capabilitiesDigest: hash(caps),
    authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1', calibrationRef: null }, capabilities: caps }; };
const result = () => ({ model: 'model-a', answers: { binary: { type: 'noul', noul: 0.8 },
  choice: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
  score: { type: 'score', score: 1.3, confidence: 0.5, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } } } });
const predictions = data => ({ schemaVersion: 1, kind: 'reflexmesh-predictions', id: 'pred-a',
  datasetDigest: evaluationDatasetDigest(data), deployment: deployment(), origin: 'synthetic-fixture',
  rows: [{ caseId: 'c1', inputDigest: evaluationCaseDigest(data, 'c1'), status: 'ok', result: result() }] });

test('dataset and per-case digests use canonical SHA-256; snapshots are isolated and frozen', () => {
  const raw = dataset(), validated = validateEvaluationDataset(raw);
  assert.notEqual(validated, raw);
  assert.equal(Object.isFrozen(validated.cases[0].state), true);
  assert.equal(evaluationDatasetDigest(validated), hash(validated));
  assert.equal(evaluationCaseDigest(validated, 'c1'), hash({ packDigest: hash(validated.pack), caseId: 'c1', state: { note: 'one' } }));
  raw.cases[0].state.note = 'changed';
  assert.equal(validated.cases[0].state.note, 'one');
  assert.throws(() => evaluationCaseDigest(validated, 'missing'), /Unknown evaluation case/);
});

test('dataset rejects extra nested pack fields, duplicate ids, oversize bytes and unsafe JSON', () => {
  const numericId = dataset(); numericId.id = 123;
  assert.throws(() => validateEvaluationDataset(numericId), /dataset identity/);
  const extra = dataset(); extra.pack.questions.binary.unexpected = true;
  assert.throws(() => validateEvaluationDataset(extra), /question fields/);
  const duplicate = dataset(); duplicate.cases[1].id = 'c1';
  assert.throws(() => validateEvaluationDataset(duplicate), /duplicate evaluation case/);
  const count = dataset(); count.cases = Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}`, state: {} }));
  assert.throws(() => validateEvaluationDataset(count), /case count/);
  const large = dataset(); large.cases[0].state = 'x'.repeat(4 * 1024 * 1024);
  assert.throws(() => validateEvaluationDataset(large), /byte limit/);
  let called = 0; const accessor = dataset();
  Object.defineProperty(accessor.cases[0], 'state', { enumerable: true, get() { called++; return {}; } });
  assert.throws(() => validateEvaluationDataset(accessor), /accessor/);
  assert.equal(called, 0);
});

test('zero-case dataset is a valid empty offline cohort with stable digests', () => {
  const raw = dataset(); raw.cases = [];
  const valid = validateEvaluationDataset(raw);
  assert.equal(valid.cases.length, 0);
  assert.strictEqual(validateEvaluationDataset(valid), valid);
  assert.equal(evaluationDatasetDigest(valid), evaluationDatasetDigest(valid));
  const emptyLabels = labels(valid); emptyLabels.labels = [];
  assert.equal(validateEvaluationLabels(emptyLabels, valid).labels.length, 0);
});

test('labelset permits partial labels but rejects repeated case/question, unknowns and invalid classes', () => {
  const data = dataset(), raw = labels(data);
  assert.equal(validateEvaluationLabels(raw, data).labels.length, 1);
  const empty = labels(data); empty.labels = [];
  assert.equal(validateEvaluationLabels(empty, data).labels.length, 0);
  raw.labels.push({ ...raw.labels[0], label: { ...raw.labels[0].label, id: 'other' } });
  assert.throws(() => validateEvaluationLabels(raw, data), /Duplicate evaluation label/);
  raw.labels.pop(); raw.labels[0].label.value = 2;
  assert.throws(() => validateEvaluationLabels(raw, data), /Binary label/);
  raw.labels[0].label.value = 1; raw.labels[0].caseId = 'foreign';
  assert.throws(() => validateEvaluationLabels(raw, data), /Unknown labeled case/);
  raw.labels[0].caseId = 'c1'; raw.datasetDigest = '0'.repeat(64);
  assert.throws(() => validateEvaluationLabels(raw, data), /labelset identity/);
  const reusedId = labels(data);
  reusedId.labels.push({ caseId: 'c1', label: { ...reusedId.labels[0].label,
    questionId: 'choice', value: 'a' } });
  assert.throws(() => validateEvaluationLabels(reusedId, data), /Duplicate evaluation label id/);
});

test('predictions accept empty/partial rows and all bounded non-ok status reasons', () => {
  const data = dataset(), raw = predictions(data);
  assert.equal(validateEvaluationPredictions(raw, data).rows.length, 1);
  raw.rows = [];
  assert.equal(validateEvaluationPredictions(raw, data).rows.length, 0);
  for (const [status, reasonCode] of [['unsupported', 'input_incompatible'], ['failed', 'provider_error'],
    ['failed', 'deadline_exceeded'], ['failed', 'cancelled'], ['not_attempted', 'budget_exhausted'],
    ['not_attempted', 'stopped_after_failure'], ['not_attempted', 'cancelled']]) {
    raw.rows = [{ caseId: 'c2', inputDigest: evaluationCaseDigest(data, 'c2'), status, reasonCode }];
    assert.equal(validateEvaluationPredictions(raw, data).rows[0].status, status);
  }
  raw.rows[0].reasonCode = 'secret-error-text';
  assert.throws(() => validateEvaluationPredictions(raw, data), /prediction reason/);
});

test('prediction identity, binding, exact result and answer compatibility fail closed', () => {
  const data = dataset(), original = predictions(data);
  assert.equal(evaluationDeploymentDigest(original.deployment), hash(original.deployment));
  const bad = mutation => { const copy = structuredClone(original); mutation(copy); assert.throws(() => validateEvaluationPredictions(copy, data)); };
  bad(p => { p.rows.push(structuredClone(p.rows[0])); });
  bad(p => { p.rows[0].caseId = 'foreign'; });
  bad(p => { p.rows[0].inputDigest = '0'.repeat(64); });
  bad(p => { p.rows[0].result.model = 'other'; });
  bad(p => { p.rows[0].result.extra = true; });
  bad(p => { p.rows[0].result.answers.binary.extra = true; });
  bad(p => { p.rows[0].result.answers.binary.noul = Infinity; });
  bad(p => { p.deployment.binding.capabilitiesDigest = '0'.repeat(64); });
  bad(p => { p.deployment.binding.extra = 'not allowed'; });
  bad(p => { p.deployment.capabilities.answers.score = 'unsupported'; p.deployment.binding.capabilitiesDigest = hash(p.deployment.capabilities); });
  bad(p => { p.deployment.capabilities.limits.maxStateBytes = 1; p.deployment.binding.capabilitiesDigest = hash(p.deployment.capabilities); });
});
