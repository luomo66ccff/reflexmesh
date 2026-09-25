import { createHash } from 'node:crypto';
import { calibrationReport } from '../dist/index.js';
import { canonical, ContractError, snapshot } from '../dist/index.js';
import { evaluatePolicy } from '../dist/index.js';
import {
  evaluationDatasetDigest, evaluationDeploymentDigest, validateEvaluationDataset,
  validateEvaluationLabels, validateEvaluationPredictions,
} from './evaluation-contract.mjs';

const EFFECTS = ['allow', 'deny', 'confirm', 'escalate'];
const STATUSES = ['ok', 'unsupported', 'failed', 'not_attempted', 'missing'];
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const check = (ok, message) => { if (!ok) throw new ContractError(message); };

function counts() { return Object.fromEntries(STATUSES.map(status => [status, 0])); }
function distribution(question) {
  const classes = question.type === 'noul' ? ['0', '1']
    : question.type === 'choice' ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
  return { byClass: Object.fromEntries(classes.map(key => [key, 0])), byProvenance: { human: 0, 'test-oracle': 0 } };
}
function addLabel(distribution, label) {
  distribution.byClass[String(label.value)]++;
  distribution.byProvenance[label.provenance]++;
}

function metrics(question, samples, binCount) {
  if (!samples.length) return null;
  if (question.type === 'noul') {
    return calibrationReport(samples.map(({ answer, label }) => ({ probability: answer.noul, label: label.value })), binCount);
  }
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    return {
      count: samples.length,
      accuracy: samples.reduce((sum, { answer, label }) => sum + Number(answer.choice === label.value), 0) / samples.length,
      multiclassBrier: samples.reduce((sum, { answer, label }) => sum + labels.reduce((square, key) =>
        square + (answer.probabilities[key] - Number(label.value === key)) ** 2, 0), 0) / samples.length,
    };
  }
  // The validated score is the value consumed by policy. It may differ from the
  // distribution expectation by the contract's small numeric tolerance.
  const errors = samples.map(({ answer, label }) => answer.score - label.value);
  return {
    count: samples.length,
    mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    rmse: Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length),
  };
}

function delta(type, champion, challenger) {
  if (!champion || !challenger) return null;
  const fields = type === 'noul' ? ['brier', 'ece'] : type === 'choice' ? ['accuracy', 'multiclassBrier'] : ['mae', 'rmse'];
  return Object.fromEntries(fields.map(name => [name, challenger[name] - champion[name]]));
}

function side(predictions) {
  const { deployment, origin } = predictions;
  return {
    deploymentId: deployment.id,
    deploymentDigest: evaluationDeploymentDigest(deployment),
    predictionsDigest: digest(predictions),
    origin,
    providerId: deployment.binding.providerId,
    modelId: deployment.binding.modelId,
    revision: deployment.binding.revision,
    capabilitiesDigest: deployment.binding.capabilitiesDigest,
    probabilitySemantics: deployment.capabilities.probabilitySemantics,
  };
}

/** Descriptive score for one prediction artifact; no invented comparator or promotion decision. */
export function scoreEvaluation({ dataset, labels, predictions, binCount = 10 }) {
  check(Number.isSafeInteger(binCount) && binCount >= 1 && binCount <= 1000, 'Invalid evaluation bin count');
  const data = validateEvaluationDataset(dataset);
  const labeled = validateEvaluationLabels(labels, data);
  const predicted = validateEvaluationPredictions(predictions, data);
  const labelsByCase = new Map(), rows = new Map(predicted.rows.map(row => [row.caseId, row]));
  for (const { caseId, label } of labeled.labels) {
    if (!labelsByCase.has(caseId)) labelsByCase.set(caseId, new Map());
    labelsByCase.get(caseId).set(label.questionId, label);
  }
  const questions = Object.entries(data.pack.questions).map(([questionId, question]) => {
    const coverage = { all: counts(), labeled: counts() };
    const all = distribution(question), scoredDistribution = distribution(question), samples = [];
    let labeledCases = 0;
    for (const item of data.cases) {
      const label = labelsByCase.get(item.id)?.get(questionId);
      const row = rows.get(item.id), status = row?.status ?? 'missing';
      coverage.all[status]++;
      if (!label) continue;
      labeledCases++; addLabel(all, label); coverage.labeled[status]++;
      if (status === 'ok') {
        samples.push({ answer: row.result.answers[questionId], label });
        addLabel(scoredDistribution, label);
      }
    }
    return { questionId, type: question.type, totalCases: data.cases.length, labeledCases,
      labelDistribution: { all, scored: scoredDistribution }, coverage,
      scored: { count: samples.length, metrics: metrics(question, samples, binCount) } };
  });
  return snapshot({
    schemaVersion: 1, kind: 'reflexmesh-evaluation-score', interpretation: 'descriptive-only',
    dataset: { id: data.id, revision: data.revision, digest: evaluationDatasetDigest(data),
      packDigest: digest(data.pack), caseCount: data.cases.length, dataKind: data.dataKind, populationRef: data.populationRef },
    labelset: { id: labeled.id, revision: labeled.revision, digest: digest(labeled),
      independence: labeled.independence, labelIndependenceVerified: false },
    prediction: side(predicted), questions, executionAllowed: false, promotionAllowed: false,
  });
}

/** Descriptive, paired offline comparison; never an authorization or promotion decision. */
export function compareEvaluations({ dataset, labels, champion, challenger, binCount = 10 }) {
  check(Number.isSafeInteger(binCount) && binCount >= 1 && binCount <= 1000, 'Invalid evaluation bin count');
  const data = validateEvaluationDataset(dataset);
  const labeled = validateEvaluationLabels(labels, data);
  const left = validateEvaluationPredictions(champion, data);
  const right = validateEvaluationPredictions(challenger, data);
  check(left.deployment.id !== right.deployment.id, 'Comparison requires distinct deployment ids');
  const labelsByCase = new Map(), leftRows = new Map(left.rows.map(row => [row.caseId, row]));
  const rightRows = new Map(right.rows.map(row => [row.caseId, row]));
  for (const { caseId, label } of labeled.labels) {
    if (!labelsByCase.has(caseId)) labelsByCase.set(caseId, new Map());
    labelsByCase.get(caseId).set(label.questionId, label);
  }

  const questions = Object.entries(data.pack.questions).map(([questionId, question]) => {
    const coverage = { champion: { all: counts(), labeled: counts() }, challenger: { all: counts(), labeled: counts() } };
    const all = distribution(question), pairedDistribution = distribution(question);
    const available = { champion: [], challenger: [] }, paired = { champion: [], challenger: [] };
    let labeledCases = 0, pairedCount = 0;
    for (const item of data.cases) {
      const label = labelsByCase.get(item.id)?.get(questionId);
      const rows = { champion: leftRows.get(item.id), challenger: rightRows.get(item.id) };
      if (label) { labeledCases++; addLabel(all, label); }
      for (const side of ['champion', 'challenger']) {
        const status = rows[side]?.status ?? 'missing';
        coverage[side].all[status]++;
        if (label) {
          coverage[side].labeled[status]++;
          if (status === 'ok') available[side].push({ answer: rows[side].result.answers[questionId], label });
        }
      }
      if (label && rows.champion?.status === 'ok' && rows.challenger?.status === 'ok') {
        pairedCount++;
        addLabel(pairedDistribution, label);
        paired.champion.push({ answer: rows.champion.result.answers[questionId], label });
        paired.challenger.push({ answer: rows.challenger.result.answers[questionId], label });
      }
    }
    const championPaired = metrics(question, paired.champion, binCount);
    const challengerPaired = metrics(question, paired.challenger, binCount);
    return {
      questionId, type: question.type, totalCases: data.cases.length, labeledCases,
      labelDistribution: { all, paired: pairedDistribution }, coverage,
      availableSubset: {
        champion: { count: available.champion.length, metrics: metrics(question, available.champion, binCount) },
        challenger: { count: available.challenger.length, metrics: metrics(question, available.challenger, binCount) },
      },
      paired: { count: pairedCount, champion: championPaired, challenger: challengerPaired,
        delta: delta(question.type, championPaired, challengerPaired) },
    };
  });

  const transitionCounts = new Map(), policy = { bothOkCount: 0, disagreementCount: 0, transitions: [] };
  for (const item of data.cases) {
    const l = leftRows.get(item.id), r = rightRows.get(item.id);
    if (l?.status !== 'ok' || r?.status !== 'ok') continue;
    const from = evaluatePolicy(data.pack, l.result.answers).effect;
    const to = evaluatePolicy(data.pack, r.result.answers).effect;
    policy.bothOkCount++;
    if (from !== to) policy.disagreementCount++;
    const key = `${from}->${to}`;
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
  }
  for (const from of EFFECTS) for (const to of EFFECTS) {
    const count = transitionCounts.get(`${from}->${to}`) ?? 0;
    if (count) policy.transitions.push({ from, to, count });
  }

  return snapshot({
    schemaVersion: 1, kind: 'reflexmesh-evaluation-report', interpretation: 'descriptive-only',
    dataset: { id: data.id, revision: data.revision, digest: evaluationDatasetDigest(data),
      packDigest: digest(data.pack), caseCount: data.cases.length, dataKind: data.dataKind, populationRef: data.populationRef },
    labelset: { id: labeled.id, revision: labeled.revision, digest: digest(labeled),
      independence: labeled.independence, labelIndependenceVerified: false },
    sides: { champion: side(left), challenger: side(right) },
    sameModelRoute: left.deployment.binding.providerId === right.deployment.binding.providerId
      && left.deployment.binding.modelId === right.deployment.binding.modelId,
    questions, policy, executionAllowed: false, promotionAllowed: false,
  });
}
