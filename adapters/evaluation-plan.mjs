import { canonical, ContractError, DEEPSEEK_ESTIMATE_CAPABILITIES,
  JEV_CAPABILITIES, snapshot } from '../dist/index.js';
import { assertProviderInput } from '../dist/core/provider-capabilities.js';
import { evaluationDatasetDigest, validateEvaluationDataset } from './evaluation-contract.mjs';

const CAPABILITIES = Object.freeze({ deepseek: DEEPSEEK_ESTIMATE_CAPABILITIES, jev: JEV_CAPABILITIES });

/** Account-free capability preview. It never constructs a provider or reads a label/key. */
export function planEvaluation({ dataset: input, provider, maxRequests }) {
  const dataset = validateEvaluationDataset(input);
  if (typeof provider !== 'string' || !Object.hasOwn(CAPABILITIES, provider))
    throw new ContractError('Select deepseek or jev for evaluation plan');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000)
    throw new ContractError('Invalid evaluation request budget');
  const capabilities = CAPABILITIES[provider];
  const eligible = [];
  for (const item of dataset.cases) {
    try { assertProviderInput(capabilities, item.state, dataset.pack.questions, new AbortController().signal); }
    catch { continue; }
    eligible.push(item);
  }
  const selected = eligible.slice(0, maxRequests);
  const canonicalInputBytes = selected.reduce((sum, item) => sum
    + Buffer.byteLength(canonical({ state: item.state, questions: dataset.pack.questions }), 'utf8'), 0);
  return snapshot({ schemaVersion: 1, kind: 'reflexmesh-evaluation-plan',
    dataset: { id: dataset.id, revision: dataset.revision, digest: evaluationDatasetDigest(dataset),
      dataKind: dataset.dataKind, cases: dataset.cases.length, questions: Object.keys(dataset.pack.questions).length },
    provider, probabilitySemantics: capabilities.probabilitySemantics,
    maxRequests, eligibleCases: eligible.length, unsupportedCases: dataset.cases.length - eligible.length,
    requestUpperBound: selected.length, deferredByRequestCapIfNoFailure: eligible.length - selected.length,
    selectedCanonicalInputBytes: canonicalInputBytes,
    estimatedCostUsd: null, credentialsRead: false, labelsRead: false, remoteAccess: false,
    modelRouteVerified: false, actualWireBytesVerified: false });
}
