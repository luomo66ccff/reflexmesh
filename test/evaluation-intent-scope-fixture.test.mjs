import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluationDatasetDigest, validateEvaluationDataset, validateEvaluationLabels } from '../adapters/evaluation-contract.mjs';
import { planEvaluation } from '../adapters/evaluation-plan.mjs';

const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), 'utf8'));

test('fixed synthetic intent/scope slice keeps independent labels and a wire-sendable DeepSeek plan', () => {
  const dataset = validateEvaluationDataset(read('evaluation-intent-scope-t001.json'));
  const labels = validateEvaluationLabels(read('evaluation-intent-scope-labels-t001.json'), dataset);
  assert.equal(dataset.dataKind, 'synthetic');
  assert.equal(dataset.cases.length, 8);
  assert.equal(labels.labels.length, 8);
  assert.equal(labels.datasetDigest, evaluationDatasetDigest(dataset));
  assert.deepEqual(labels.labels.map(item => item.label.value), [1, 0, 1, 0, 1, 0, 1, 0]);
  assert.ok(labels.labels.every(item => item.label.provenance === 'test-oracle'));
  const plan = planEvaluation({ dataset, provider: 'deepseek', maxRequests: 8,
    modelId: 'deepseek-flash', revision: 'fixture-route-v1', maxOutputTokens: 128 });
  assert.equal(plan.eligibleCases, 8);
  assert.equal(plan.wirePreflight.sendableCases, 8);
  assert.equal(plan.wirePreflight.requestUpperBound, 8);
  assert.equal(plan.credentialsRead, false);
  assert.equal(plan.remoteAccess, false);
});
