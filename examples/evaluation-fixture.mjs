import { MockProvider } from '../dist/index.js';
import { evaluationDatasetDigest, validateEvaluationDataset, validateEvaluationLabels } from '../adapters/evaluation-contract.mjs';

/** Deliberately synthetic predictions. Targets come from an independent, fixed key-equality oracle. */
export function comparisonFixture() {
  const dataset = validateEvaluationDataset({ schemaVersion: 1, kind: 'reflexmesh-dataset', id: 'key-equality-fixture', revision: '1',
    populationRef: 'fixture:four-exact-key-pairs', dataKind: 'synthetic',
    pack: { id: 'key-equality', version: '1', eventType: 'fixture.key-pair', questions: {
      match: { type: 'noul', instructions: 'Is requestedKey exactly equal to observedKey in the supplied state?' },
    }, rules: [
      { id: 'matched', all: [{ answer: 'match', metric: 'value', op: 'gte', value: 0.75 }], effect: 'allow' },
      { id: 'mismatched', all: [{ answer: 'match', metric: 'value', op: 'lte', value: 0.25 }], effect: 'deny' },
    ], fallback: 'escalate' },
    cases: [
      { id: 'easy-match', state: { requestedKey: 'alpha', observedKey: 'alpha' } },
      { id: 'easy-mismatch', state: { requestedKey: 'alpha', observedKey: 'beta' } },
      { id: 'remaining-match', state: { requestedKey: 'gamma', observedKey: 'gamma' } },
      { id: 'remaining-mismatch', state: { requestedKey: 'gamma', observedKey: 'delta' } },
    ] });
  const labels = validateEvaluationLabels({ schemaVersion: 1, kind: 'reflexmesh-labelset', id: 'key-equality-targets', revision: '1',
    datasetDigest: evaluationDatasetDigest(dataset), independence: 'operator-asserted-independent',
    labels: dataset.cases.map(item => ({ caseId: item.id, label: { id: `target-${item.id}`, questionId: 'match',
      value: item.state.requestedKey === item.state.observedKey ? 1 : 0, provenance: 'test-oracle', sourceRef: 'fixture:exact-key-equality-v1' } })) }, dataset);
  return { dataset, labels };
}
export function fixtureDeployment(side) {
  if (!['champion', 'challenger'].includes(side)) throw new Error('Unknown synthetic side');
  const values = side === 'champion' ? [0.8, 0.2, 0.4, 0.6] : [0.7, 0.3]; let calls = 0;
  const provider = new MockProvider(() => {
    const index = calls++;
    if (index >= values.length) throw new Error('Synthetic provider unavailable');
    return { model: 'synthetic-key-match', answers: { match: { type: 'noul', noul: values[index] } } };
  });
  return { provider, binding: { providerId: provider.id, modelId: 'synthetic-key-match', revision: `fixture-${side}-v1`, calibrationRef: null,
    authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1' } };
}
