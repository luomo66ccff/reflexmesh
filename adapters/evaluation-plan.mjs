import { createHash } from 'node:crypto';
import { canonical, ContractError, DEEPSEEK_ESTIMATE_CAPABILITIES,
  DEEPSEEK_REQUEST_BYTE_LIMIT, deepSeekRequestBody, JEV_CAPABILITIES,
  JEV_REQUEST_BYTE_LIMIT, jevRequestBody, snapshot } from '../dist/index.js';
import { assertProviderInput } from '../dist/core/provider-capabilities.js';
import { evaluationDatasetDigest, validateEvaluationDataset } from './evaluation-contract.mjs';

const CAPABILITIES = Object.freeze({ deepseek: DEEPSEEK_ESTIMATE_CAPABILITIES, jev: JEV_CAPABILITIES });
export const EVALUATION_PROVIDER_IDS = Object.freeze({
  deepseek: 'deepseek/binary-json-estimate-v1', jev: 'typesafe/jev',
});
const validRouteText = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Account-free capability preview. It never constructs a provider or reads a label/key. */
export function planEvaluation({ dataset: input, provider, maxRequests, modelId, revision, maxOutputTokens }) {
  const dataset = validateEvaluationDataset(input);
  if (typeof provider !== 'string' || !Object.hasOwn(CAPABILITIES, provider))
    throw new ContractError('Select deepseek or jev for evaluation plan');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000)
    throw new ContractError('Invalid evaluation request budget');
  const routeDeclared = modelId !== undefined || revision !== undefined;
  if (routeDeclared && (!validRouteText(modelId) || !validRouteText(revision)
    || (provider === 'deepseek' && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(modelId))))
    throw new ContractError('Explicit valid evaluation model ID and provider revision required');
  if (maxOutputTokens !== undefined && (!routeDeclared || provider !== 'deepseek'
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096))
    throw new ContractError('DeepSeek output token limit requires a declared route');
  const capabilities = CAPABILITIES[provider];
  const eligible = [];
  for (const item of dataset.cases) {
    try { assertProviderInput(capabilities, item.state, dataset.pack.questions, new AbortController().signal); }
    catch { continue; }
    eligible.push(item);
  }
  const selected = eligible.slice(0, maxRequests);
  let wirePreflight = { status: 'not_checked', reason: 'model_not_declared' };
  if (routeDeclared) {
    const outputTokens = provider === 'deepseek' ? maxOutputTokens ?? 512 : null;
    const sendable = [];
    const wireBytes = new Map();
    for (const item of eligible) {
      const body = provider === 'deepseek'
        ? deepSeekRequestBody(modelId, item.state, dataset.pack.questions, outputTokens)
        : jevRequestBody(modelId, item.state, dataset.pack.questions);
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > (provider === 'deepseek' ? DEEPSEEK_REQUEST_BYTE_LIMIT : JEV_REQUEST_BYTE_LIMIT)) continue;
      sendable.push(item); wireBytes.set(item.id, bytes);
    }
    const wireSelected = sendable.slice(0, maxRequests);
    wirePreflight = { status: 'checked', ...(provider === 'deepseek' ? { maxOutputTokens: outputTokens } : {}),
      sendableCases: sendable.length, wireRejectedCases: eligible.length - sendable.length,
      requestUpperBound: wireSelected.length,
      deferredByRequestCapIfNoFailure: sendable.length - wireSelected.length,
      selectedRequestBodyBytes: wireSelected.reduce((sum, item) => sum + wireBytes.get(item.id), 0) };
  }
  const canonicalInputBytes = selected.reduce((sum, item) => sum
    + Buffer.byteLength(canonical({ state: item.state, questions: dataset.pack.questions }), 'utf8'), 0);
  const datasetDigest = evaluationDatasetDigest(dataset);
  const capabilitiesDigest = createHash('sha256').update(canonical(capabilities)).digest('hex');
  const guardDigest = createHash('sha256').update(canonical({ schemaVersion: 1,
    kind: 'reflexmesh-evaluation-plan-guard', datasetDigest, provider, maxRequests,
    capabilitiesDigest })).digest('hex');
  const route = routeDeclared ? { providerId: EVALUATION_PROVIDER_IDS[provider], modelId, revision } : null;
  const routeGuardDigest = routeDeclared ? createHash('sha256').update(canonical({
    schemaVersion: 1, kind: 'reflexmesh-evaluation-route-plan-guard',
    guardDigest, route })).digest('hex') : null;
  return snapshot({ schemaVersion: 1, kind: 'reflexmesh-evaluation-plan',
    dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest,
      dataKind: dataset.dataKind, cases: dataset.cases.length, questions: Object.keys(dataset.pack.questions).length },
    provider, probabilitySemantics: capabilities.probabilitySemantics, capabilitiesDigest, guardDigest,
    ...(routeDeclared ? { declaredRoute: route, routeGuardDigest } : {}),
    maxRequests, eligibleCases: eligible.length, unsupportedCases: dataset.cases.length - eligible.length,
    requestUpperBound: selected.length, deferredByRequestCapIfNoFailure: eligible.length - selected.length,
    selectedCanonicalInputBytes: canonicalInputBytes, wirePreflight,
    estimatedCostUsd: null, credentialsRead: false, labelsRead: false, remoteAccess: false,
    modelRouteVerified: false, actualWireBytesVerified: false });
}
