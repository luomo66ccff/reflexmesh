import { DeepSeekEstimateProvider, JevProvider, ContractError } from '../dist/index.js';
import { normalizeProviderBinding } from './provider-binding.mjs';

/** Explicit process environment only; no host profile, credential file, .env loader or arbitrary endpoint. */
export function createEvaluationProvider(env, { fetch, maxOutputTokens } = {}) {
  if (env.REFLEXMESH_ALLOW_REMOTE !== 'true') throw new ContractError('Explicit REFLEXMESH_ALLOW_REMOTE=true required for evaluation egress');
  if (typeof env.REFLEXMESH_PROVIDER_REVISION !== 'string' || !env.REFLEXMESH_PROVIDER_REVISION.trim())
    throw new ContractError('Explicit evaluated provider revision required');
  let provider;
  if (env.REFLEXMESH_PROVIDER === 'deepseek') provider = new DeepSeekEstimateProvider({ apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL, ...(fetch ? { fetch } : {}), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
  else if (env.REFLEXMESH_PROVIDER === 'jev') {
    if (maxOutputTokens !== undefined) throw new ContractError('Jev does not declare an output-token budget option');
    provider = new JevProvider({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL, ...(fetch ? { fetch } : {}) });
  } else throw new ContractError('Evaluation requires an explicitly selected deepseek or jev provider');
  return { provider, binding: normalizeProviderBinding(provider, { providerId: provider.id, modelId: provider.model,
    revision: env.REFLEXMESH_PROVIDER_REVISION, calibrationRef: null,
    authorizationRevision: 'eval-no-execution-v1', toolsetRevision: 'eval-no-tools-v1' }) };
}
