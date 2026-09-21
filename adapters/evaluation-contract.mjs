import { createHash } from 'node:crypto';
import { canonical, ContractError, record, snapshot, validatePack, validateResult } from '../dist/index.js';
import { assertProviderInput, validateProviderCapabilities } from '../dist/core/provider-capabilities.js';
import { validateLabelEnvelope, validateLabelValue } from './recovery-contract.mjs';

const MAX_CASES = 1000;
const MAX_DATASET_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const validatedDatasets = new WeakSet();
const datasetDigests = new WeakMap();
const packDigests = new WeakMap();
const BINDING_KEYS = ['providerId', 'modelId', 'revision', 'capabilitiesDigest', 'authorizationRevision', 'toolsetRevision', 'calibrationRef'];
const ROW_REASONS = Object.freeze({
  unsupported: ['input_incompatible'],
  failed: ['provider_error', 'deadline_exceeded', 'cancelled'],
  not_attempted: ['budget_exhausted', 'stopped_after_failure', 'cancelled'],
});

function check(ok, message) { if (!ok) throw new ContractError(message); }
function exact(value, keys, message) {
  check(record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), message);
}
function bounded(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

function strictPack(pack) {
  validatePack(pack);
  exact(pack, ['id', 'version', 'eventType', 'questions', 'rules', 'fallback'], 'Invalid evaluation pack fields');
  check(bounded(pack.id, 128) && bounded(pack.version, 128) && bounded(pack.eventType, 128), 'Invalid evaluation pack metadata');
  for (const question of Object.values(pack.questions)) {
    exact(question, question.type === 'noul' ? ['type', 'instructions'] : ['type', 'instructions', 'criteria'], 'Invalid evaluation question fields');
  }
  for (const rule of pack.rules) {
    exact(rule, rule.directive === undefined ? ['id', 'all', 'effect'] : ['id', 'all', 'effect', 'directive'], 'Invalid evaluation rule fields');
    for (const condition of rule.all) exact(condition, ['answer', 'metric', 'op', 'value'], 'Invalid evaluation condition fields');
  }
}

export function validateEvaluationDataset(input) {
  if (input !== null && typeof input === 'object' && validatedDatasets.has(input)) return input;
  const value = snapshot(input);
  exact(value, ['schemaVersion', 'kind', 'id', 'revision', 'populationRef', 'dataKind', 'pack', 'cases'], 'Invalid evaluation dataset fields');
  check(value.schemaVersion === 1 && value.kind === 'reflexmesh-dataset', 'Unsupported evaluation dataset');
  check(validId(value.id) && bounded(value.revision, 128) && bounded(value.populationRef, 512), 'Invalid evaluation dataset identity');
  check(['synthetic', 'user-supplied'].includes(value.dataKind), 'Invalid evaluation data kind');
  strictPack(value.pack);
  check(Array.isArray(value.cases) && value.cases.length <= MAX_CASES, 'Invalid evaluation case count');
  const seen = new Set();
  for (const item of value.cases) {
    exact(item, ['id', 'state'], 'Invalid evaluation case fields');
    check(validId(item.id) && !seen.has(item.id), 'Invalid or duplicate evaluation case');
    seen.add(item.id);
  }
  check(Buffer.byteLength(canonical(value), 'utf8') <= MAX_DATASET_BYTES, 'Evaluation dataset byte limit exceeded');
  validatedDatasets.add(value);
  return value;
}

export function evaluationDatasetDigest(dataset) {
  const value = validateEvaluationDataset(dataset);
  if (!datasetDigests.has(value)) datasetDigests.set(value, digest(value));
  return datasetDigests.get(value);
}

function packDigest(dataset) {
  if (!packDigests.has(dataset)) packDigests.set(dataset, digest(dataset.pack));
  return packDigests.get(dataset);
}

export function evaluationCaseDigest(dataset, caseId) {
  const value = validateEvaluationDataset(dataset);
  check(typeof caseId === 'string', 'Invalid evaluation case');
  const item = value.cases.find(row => row.id === caseId);
  check(item !== undefined, 'Unknown evaluation case');
  return digest({ packDigest: packDigest(value), caseId, state: item.state });
}

export function validateEvaluationLabels(input, dataset) {
  const basis = validateEvaluationDataset(dataset), value = snapshot(input);
  exact(value, ['schemaVersion', 'kind', 'id', 'revision', 'datasetDigest', 'independence', 'labels'], 'Invalid evaluation labelset fields');
  check(value.schemaVersion === 1 && value.kind === 'reflexmesh-labelset', 'Unsupported evaluation labelset');
  check(validId(value.id) && bounded(value.revision, 128) && value.datasetDigest === evaluationDatasetDigest(basis), 'Invalid evaluation labelset identity');
  check(value.independence === 'operator-asserted-independent', 'Invalid label independence declaration');
  check(Array.isArray(value.labels) && value.labels.length <= basis.cases.length * Object.keys(basis.pack.questions).length, 'Invalid evaluation label count');
  const cases = new Set(basis.cases.map(item => item.id)), seen = new Set(), labelIds = new Set();
  for (const item of value.labels) {
    exact(item, ['caseId', 'label'], 'Invalid evaluation label row');
    check(cases.has(item.caseId), 'Unknown labeled case');
    const label = validateLabelEnvelope(item.label);
    check(Object.hasOwn(basis.pack.questions, label.questionId), 'Unknown labeled question');
    validateLabelValue(basis.pack.questions[label.questionId], label.value);
    const key = `${item.caseId}\u0000${label.questionId}`;
    check(!seen.has(key), 'Duplicate evaluation label');
    check(!labelIds.has(label.id), 'Duplicate evaluation label id');
    seen.add(key);
    labelIds.add(label.id);
  }
  return value;
}

function validateDeployment(input) {
  const value = snapshot(input);
  exact(value, ['id', 'binding', 'capabilities'], 'Invalid evaluation deployment fields');
  check(validId(value.id), 'Invalid evaluation deployment id');
  exact(value.binding, BINDING_KEYS, 'Invalid evaluation binding fields');
  for (const key of BINDING_KEYS.slice(0, 6)) {
    check(key === 'capabilitiesDigest' ? HASH.test(value.binding[key]) : bounded(value.binding[key], 256), `Invalid evaluation binding ${key}`);
  }
  check(value.binding.calibrationRef === null || bounded(value.binding.calibrationRef, 512), 'Invalid calibration reference');
  const capabilities = validateProviderCapabilities(value.capabilities);
  check(value.binding.capabilitiesDigest === digest(capabilities), 'Evaluation capabilities digest mismatch');
  return value;
}

export function evaluationDeploymentDigest(deployment) { return digest(validateDeployment(deployment)); }

export function validateEvaluationPredictions(input, dataset) {
  const basis = validateEvaluationDataset(dataset), value = snapshot(input);
  exact(value, ['schemaVersion', 'kind', 'id', 'datasetDigest', 'deployment', 'origin', 'rows'], 'Invalid evaluation predictions fields');
  check(value.schemaVersion === 1 && value.kind === 'reflexmesh-predictions', 'Unsupported evaluation predictions');
  check(validId(value.id) && value.datasetDigest === evaluationDatasetDigest(basis), 'Invalid evaluation predictions identity');
  const deployment = validateDeployment(value.deployment);
  check(['provider-run', 'imported', 'synthetic-fixture'].includes(value.origin), 'Invalid evaluation origin');
  check(Array.isArray(value.rows) && value.rows.length <= basis.cases.length, 'Invalid evaluation prediction count');
  const cases = new Map(basis.cases.map(item => [item.id, item])), seen = new Set(), basisPackDigest = packDigest(basis);
  for (const row of value.rows) {
    check(record(row) && ['ok', 'unsupported', 'failed', 'not_attempted'].includes(row.status), 'Invalid evaluation prediction status');
    exact(row, row.status === 'ok' ? ['caseId', 'inputDigest', 'status', 'result'] : ['caseId', 'inputDigest', 'status', 'reasonCode'], 'Invalid evaluation prediction row');
    check(cases.has(row.caseId) && !seen.has(row.caseId), 'Unknown or duplicate evaluation prediction case');
    seen.add(row.caseId);
    const item = cases.get(row.caseId);
    check(row.inputDigest === digest({ packDigest: basisPackDigest, caseId: row.caseId, state: item.state }), 'Evaluation input digest mismatch');
    if (row.status === 'ok') {
      assertProviderInput(deployment.capabilities, item.state, basis.pack.questions, new AbortController().signal);
      const result = validateResult(basis.pack.questions, row.result);
      check(canonical(row.result) === canonical(result), 'Invalid evaluation result fields');
      check(result.model === deployment.binding.modelId, 'Evaluation result model mismatch');
    } else check(ROW_REASONS[row.status].includes(row.reasonCode), 'Invalid evaluation prediction reason');
  }
  return value;
}
