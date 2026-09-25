import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../dist/index.js';
import { evaluationDatasetDigest, evaluationCaseDigest } from '../adapters/evaluation-contract.mjs';
import { compareEvaluations, scoreEvaluation } from '../adapters/evaluation-report.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const dataset = () => ({ schemaVersion: 1, kind: 'reflexmesh-dataset', id: 'dataset', revision: 'rev1',
  populationRef: 'hand-computed-fixture', dataKind: 'synthetic',
  pack: { id: 'three-types', version: 'v1', eventType: 'evaluation.case',
    questions: { binary: { type: 'noul', instructions: 'Risk?' },
      choice: { type: 'choice', instructions: 'Route?', criteria: { a: 'A', b: 'B' } },
      score: { type: 'score', instructions: 'Level?', criteria: ['low', 'medium', 'high'] } },
    rules: [{ id: 'risk', all: [{ answer: 'binary', metric: 'value', op: 'gte', value: 0.5 }], effect: 'deny' }],
    fallback: 'confirm' },
  cases: [{ id: 'c1', state: { n: 1 } }, { id: 'c2', state: { n: 2 } }, { id: 'c3', state: { n: 3 } }] });
const caps = () => ({ schemaVersion: 1, resultContract: 'probabilistic-v1', probabilitySemantics: 'synthetic-fixture',
  answers: { noul: 'probability', choice: 'distribution-with-confidence', score: 'distribution-with-confidence-and-expected-value' },
  limits: { maxStateBytes: 100, maxQuestions: 3, maxChoicesPerQuestion: 3 } });
function deployment(id) { const capabilities = caps(); return { id,
  binding: { providerId: 'fixture', modelId: 'shared-model', revision: 'v1', capabilitiesDigest: hash(capabilities),
    authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1', calibrationRef: null }, capabilities }; }
function result(binary, choice, a, scoreProbabilities) {
  return { model: 'shared-model', answers: {
    binary: { type: 'noul', noul: binary },
    choice: { type: 'choice', choice, confidence: choice === 'a' ? a : 1 - a, probabilities: { a, b: 1 - a } },
    score: { type: 'score', score: scoreProbabilities[1] + 2 * scoreProbabilities[2], confidence: 0.5,
      probabilities: { '0': scoreProbabilities[0], '1': scoreProbabilities[1], '2': scoreProbabilities[2] } },
  } };
}
function predictions(data, id, rows) { return { schemaVersion: 1, kind: 'reflexmesh-predictions', id: `${id}-pred`,
  datasetDigest: evaluationDatasetDigest(data), deployment: deployment(id), origin: 'synthetic-fixture',
  rows: rows.map(([caseId, value]) => ({ caseId, inputDigest: evaluationCaseDigest(data, caseId),
    ...(typeof value === 'string' ? { status: 'failed', reasonCode: value } : { status: 'ok', result: value }) })) }; }
function labels(data) {
  const definitions = [
    ['c1', 'binary', 1, 'human'], ['c1', 'choice', 'a', 'human'], ['c1', 'score', 2, 'human'],
    ['c2', 'binary', 0, 'test-oracle'], ['c2', 'choice', 'b', 'test-oracle'], ['c2', 'score', 0, 'test-oracle'],
  ];
  return { schemaVersion: 1, kind: 'reflexmesh-labelset', id: 'labels', revision: 'v1',
    datasetDigest: evaluationDatasetDigest(data), independence: 'operator-asserted-independent',
    labels: definitions.map(([caseId, questionId, value, provenance], i) => ({ caseId,
      label: { id: `label-${i}`, questionId, value, provenance, sourceRef: 'fixture-declaration' } })) };
}
function fixture() {
  const data = dataset();
  const champion = predictions(data, 'deploy-champion', [
    ['c1', result(0.8, 'a', 0.8, [0.2, 0.3, 0.5])],
    ['c2', result(0.1, 'b', 0.1, [0.8, 0.2, 0])],
    ['c3', result(0.2, 'a', 0.7, [0.5, 0.5, 0])],
  ]);
  const challenger = predictions(data, 'deploy-challenger', [
    ['c1', result(0.6, 'b', 0.4, [0.1, 0.2, 0.7])],
    ['c2', 'provider_error'],
    ['c3', result(0.7, 'a', 0.7, [0.5, 0.5, 0])],
  ]);
  return { dataset: data, labels: labels(data), champion, challenger };
}

test('paired binary Brier/ECE use one identical labeled case, not independent available subsets', () => {
  const report = compareEvaluations(fixture());
  const q = report.questions.find(item => item.questionId === 'binary');
  assert.equal(q.totalCases, 3); assert.equal(q.labeledCases, 2); assert.equal(q.paired.count, 1);
  assert.deepEqual(q.coverage.champion.all, { ok: 3, unsupported: 0, failed: 0, not_attempted: 0, missing: 0 });
  assert.deepEqual(q.coverage.challenger.labeled, { ok: 1, unsupported: 0, failed: 1, not_attempted: 0, missing: 0 });
  assert.equal(q.availableSubset.champion.count, 2); assert.equal(q.availableSubset.challenger.count, 1);
  near(q.availableSubset.champion.metrics.brier, 0.025);
  near(q.paired.champion.brier, 0.04); near(q.paired.challenger.brier, 0.16); near(q.paired.delta.brier, 0.12);
  near(q.paired.champion.ece, 0.2); near(q.paired.challenger.ece, 0.4); near(q.paired.delta.ece, 0.2);
  assert.equal(q.paired.champion.bins.reduce((sum, bin) => sum + bin.count, 0), 1);
  assert.deepEqual(q.labelDistribution.all, { byClass: { '0': 1, '1': 1 }, byProvenance: { human: 1, 'test-oracle': 1 } });
  assert.deepEqual(q.labelDistribution.paired, { byClass: { '0': 0, '1': 1 }, byProvenance: { human: 1, 'test-oracle': 0 } });
});

test('choice multiclass Brier sums class squares; score errors use validated score without rounding', () => {
  const report = compareEvaluations(fixture());
  const choice = report.questions.find(item => item.questionId === 'choice');
  near(choice.paired.champion.multiclassBrier, 0.08);
  near(choice.paired.challenger.multiclassBrier, 0.72);
  near(choice.paired.delta.multiclassBrier, 0.64);
  assert.equal(choice.paired.champion.accuracy, 1);
  assert.equal(choice.paired.challenger.accuracy, 0);
  assert.equal(choice.paired.delta.accuracy, -1);
  near(choice.availableSubset.champion.metrics.multiclassBrier, 0.05);
  const score = report.questions.find(item => item.questionId === 'score');
  near(score.paired.champion.mae, 0.7); near(score.paired.champion.rmse, 0.7);
  near(score.paired.challenger.mae, 0.4); near(score.paired.challenger.rmse, 0.4);
  near(score.paired.delta.mae, -0.3); near(score.paired.delta.rmse, -0.3);
  near(score.availableSubset.champion.metrics.mae, 0.45);
  assert.deepEqual(score.labelDistribution.all.byClass, { '0': 1, '1': 0, '2': 1 });
  assert.deepEqual(score.labelDistribution.paired.byClass, { '0': 0, '1': 0, '2': 1 });
});

test('ordinal metrics reflect the policy-visible score within the accepted expectation tolerance', () => {
  const inputs = fixture();
  inputs.champion.rows[0].result.answers.score.score = 1.301; // Expected value remains 1.3.
  const score = compareEvaluations(inputs).questions.find(item => item.questionId === 'score');
  near(score.paired.champion.mae, 0.699);
  near(score.paired.champion.rmse, 0.699);
  near(score.paired.delta.mae, -0.299);
  near(score.availableSubset.champion.metrics.mae, 0.4495);
});

test('policy compares both-ok rows including unlabeled cases and makes no action claim', () => {
  const report = compareEvaluations(fixture());
  assert.deepEqual(report.policy, { bothOkCount: 2, disagreementCount: 1,
    transitions: [{ from: 'deny', to: 'deny', count: 1 }, { from: 'confirm', to: 'deny', count: 1 }] });
  assert.equal(report.executionAllowed, false); assert.equal(report.promotionAllowed, false);
  assert.equal(report.interpretation, 'descriptive-only');
  assert.equal(report.sameModelRoute, true); assert.equal(Object.hasOwn(report, 'sameModel'), false);
  assert.equal(report.labelset.labelIndependenceVerified, false);
  assert.equal(report.dataset.digest, evaluationDatasetDigest(fixture().dataset));
  assert.equal(report.sides.champion.predictionsDigest, hash(fixture().champion));
  assert.equal(report.sides.challenger.probabilitySemantics, 'synthetic-fixture');
  assert.equal(Object.isFrozen(report.questions[0].paired), true);
});

test('an empty cohort and a populated cohort without labels report null metrics honestly', () => {
  const empty = fixture();
  empty.dataset.cases = [];
  empty.labels.datasetDigest = evaluationDatasetDigest(empty.dataset); empty.labels.labels = [];
  for (const side of [empty.champion, empty.challenger]) {
    side.datasetDigest = evaluationDatasetDigest(empty.dataset); side.rows = [];
  }
  const emptyReport = compareEvaluations(empty);
  assert.equal(emptyReport.dataset.caseCount, 0);
  assert.equal(emptyReport.policy.bothOkCount, 0);
  for (const question of emptyReport.questions) {
    assert.equal(question.totalCases, 0); assert.equal(question.labeledCases, 0);
    assert.equal(question.paired.count, 0); assert.equal(question.paired.delta, null);
    assert.equal(question.availableSubset.champion.metrics, null);
    assert.equal(question.coverage.challenger.all.missing, 0);
  }
  const unlabeled = fixture(); unlabeled.labels.labels = [];
  const unlabeledReport = compareEvaluations(unlabeled);
  assert.equal(unlabeledReport.policy.bothOkCount, 2); // Policy comparison needs no labels.
  for (const question of unlabeledReport.questions) {
    assert.equal(question.totalCases, 3); assert.equal(question.labeledCases, 0);
    assert.equal(question.paired.count, 0); assert.equal(question.paired.delta, null);
    assert.equal(question.availableSubset.champion.count, 0);
    assert.equal(question.coverage.champion.all.ok, 3);
    assert.equal(question.coverage.champion.labeled.ok, 0);
  }
});

test('independent successful sides with no overlapping labeled case produce no paired delta', () => {
  const inputs = fixture();
  inputs.champion.rows = inputs.champion.rows.filter(row => row.caseId === 'c1');
  inputs.challenger.rows = [
    { caseId: 'c2', inputDigest: evaluationCaseDigest(inputs.dataset, 'c2'), status: 'ok',
      result: result(0.1, 'b', 0.1, [0.8, 0.2, 0]) },
  ];
  const report = compareEvaluations(inputs);
  for (const question of report.questions) {
    assert.equal(question.availableSubset.champion.count, 1);
    assert.equal(question.availableSubset.challenger.count, 1);
    assert.equal(question.paired.count, 0);
    assert.equal(question.paired.champion, null);
    assert.equal(question.paired.challenger, null);
    assert.equal(question.paired.delta, null);
  }
  assert.equal(report.policy.bothOkCount, 0);
});

test('per-question label coverage and paired distributions do not borrow labels from other questions', () => {
  const inputs = fixture();
  inputs.labels.labels = inputs.labels.labels.filter(row => row.label.questionId === 'binary');
  inputs.labels.labels.push({ caseId: 'c3', label: {
    id: 'choice-c3', questionId: 'choice', value: 'a', provenance: 'human', sourceRef: 'fixture-declaration' } });
  const report = compareEvaluations(inputs);
  const [binary, choice, score] = report.questions;
  assert.deepEqual(report.questions.map(q => q.labeledCases), [2, 1, 0]);
  assert.deepEqual(report.questions.map(q => q.paired.count), [1, 1, 0]);
  assert.equal(choice.coverage.champion.labeled.ok, 1);
  assert.equal(choice.coverage.challenger.labeled.ok, 1);
  assert.equal(choice.labelDistribution.paired.byClass.a, 1);
  assert.equal(binary.labelDistribution.paired.byClass['1'], 1);
  assert.equal(score.availableSubset.champion.metrics, null);
  assert.equal(score.paired.delta, null);
});

test('same model id under a different provider id is not the same declared route', () => {
  const inputs = fixture();
  inputs.challenger.deployment.binding.providerId = 'other-provider';
  const report = compareEvaluations(inputs);
  assert.equal(report.sides.champion.modelId, report.sides.challenger.modelId);
  assert.notEqual(report.sides.champion.providerId, report.sides.challenger.providerId);
  assert.equal(report.sameModelRoute, false);
});

test('missing, unsupported, not-attempted and zero paired samples remain explicit; metrics are null', () => {
  const inputs = fixture();
  inputs.challenger.rows = [
    { caseId: 'c1', inputDigest: evaluationCaseDigest(inputs.dataset, 'c1'), status: 'unsupported', reasonCode: 'input_incompatible' },
    { caseId: 'c2', inputDigest: evaluationCaseDigest(inputs.dataset, 'c2'), status: 'not_attempted', reasonCode: 'budget_exhausted' },
  ];
  const report = compareEvaluations(inputs), q = report.questions[0];
  assert.deepEqual(q.coverage.challenger.all, { ok: 0, unsupported: 1, failed: 0, not_attempted: 1, missing: 1 });
  assert.equal(q.paired.count, 0); assert.equal(q.paired.champion, null);
  assert.equal(q.paired.challenger, null); assert.equal(q.paired.delta, null);
  assert.equal(q.availableSubset.challenger.count, 0); assert.equal(q.availableSubset.challenger.metrics, null);
  assert.equal(report.policy.bothOkCount, 0);
});

test('comparison revalidates identities, disallows same deployment and invalid bins', () => {
  const baseline = fixture();
  assert.throws(() => compareEvaluations({ ...baseline, binCount: 0 }), /bin count/);
  const same = fixture(); same.challenger.deployment.id = same.champion.deployment.id;
  assert.throws(() => compareEvaluations(same), /distinct deployment ids/);
  const bad = fixture(); bad.challenger.rows[0].result.answers.score.probabilities['2'] = 0.8;
  assert.throws(() => compareEvaluations(bad), /sum to one/);
  const mismatched = fixture(); mismatched.labels.datasetDigest = '0'.repeat(64);
  assert.throws(() => compareEvaluations(mismatched), /labelset identity/);
});

test('single-side score uses the same validated metrics without a fabricated comparator', () => {
  const { dataset, labels, champion } = fixture();
  const report = scoreEvaluation({ dataset, labels, predictions: champion });
  assert.equal(report.kind, 'reflexmesh-evaluation-score');
  assert.equal(report.interpretation, 'descriptive-only');
  assert.equal(report.executionAllowed, false); assert.equal(report.promotionAllowed, false);
  assert.equal(report.prediction.deploymentId, 'deploy-champion');
  assert.equal(report.prediction.origin, 'synthetic-fixture');
  assert.equal(report.labelset.labelIndependenceVerified, false);
  assert.equal(Object.hasOwn(report, 'sides'), false);
  assert.equal(Object.hasOwn(report, 'paired'), false);
  assert.equal(Object.hasOwn(report, 'delta'), false);
  const [binary, choice, score] = report.questions;
  assert.equal(binary.labeledCases, 2); assert.equal(binary.scored.count, 2);
  assert.deepEqual(binary.coverage.all, { ok: 3, unsupported: 0, failed: 0, not_attempted: 0, missing: 0 });
  assert.deepEqual(binary.labelDistribution.scored.byClass, { '0': 1, '1': 1 });
  near(binary.scored.metrics.brier, 0.025);
  assert.equal(choice.scored.metrics.accuracy, 1);
  near(choice.scored.metrics.multiclassBrier, 0.05);
  near(score.scored.metrics.mae, 0.45);
  assert.equal(Object.isFrozen(report.questions[0].scored), true);
});

test('single-side score preserves failed and missing coverage, selection balance and null metrics', () => {
  const inputs = fixture();
  const report = scoreEvaluation({ dataset: inputs.dataset, labels: inputs.labels, predictions: inputs.challenger });
  const binary = report.questions[0];
  assert.deepEqual(binary.coverage.all, { ok: 2, unsupported: 0, failed: 1, not_attempted: 0, missing: 0 });
  assert.deepEqual(binary.coverage.labeled, { ok: 1, unsupported: 0, failed: 1, not_attempted: 0, missing: 0 });
  assert.deepEqual(binary.labelDistribution.all.byClass, { '0': 1, '1': 1 });
  assert.deepEqual(binary.labelDistribution.scored.byClass, { '0': 0, '1': 1 });
  assert.equal(binary.scored.count, 1); near(binary.scored.metrics.brier, 0.16);
  const missing = fixture(); missing.challenger.rows = missing.challenger.rows.filter(row => row.caseId === 'c2');
  const missingScore = scoreEvaluation({ dataset: missing.dataset, labels: missing.labels,
    predictions: missing.challenger }).questions[0];
  assert.equal(missingScore.coverage.all.missing, 2);
  assert.equal(missingScore.coverage.labeled.missing, 1);
  assert.equal(missingScore.scored.count, 0);
  assert.equal(missingScore.scored.metrics, null);
  assert.deepEqual(missingScore.labelDistribution.scored.byClass, { '0': 0, '1': 0 });
  const unlabeled = fixture(); unlabeled.labels.labels = [];
  const noLabels = scoreEvaluation({ dataset: unlabeled.dataset, labels: unlabeled.labels,
    predictions: unlabeled.champion }).questions[0];
  assert.equal(noLabels.labeledCases, 0); assert.equal(noLabels.scored.count, 0);
  assert.equal(noLabels.scored.metrics, null); assert.equal(noLabels.coverage.all.ok, 3);
});

test('single-side score rejects bad bins, mismatched labels and invalid prediction rows', () => {
  const inputs = fixture();
  const args = { dataset: inputs.dataset, labels: inputs.labels, predictions: inputs.champion };
  assert.throws(() => scoreEvaluation({ ...args, binCount: 0 }), /bin count/);
  const badLabels = structuredClone(inputs.labels); badLabels.datasetDigest = '0'.repeat(64);
  assert.throws(() => scoreEvaluation({ ...args, labels: badLabels }), /labelset identity/);
  const badPredictions = structuredClone(inputs.champion);
  badPredictions.rows[0].result.answers.score.probabilities['2'] = 0.8;
  assert.throws(() => scoreEvaluation({ ...args, predictions: badPredictions }), /sum to one/);
});
