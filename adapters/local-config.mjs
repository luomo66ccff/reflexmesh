import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { JevProvider, DeepSeekEstimateProvider, toolPreflightPack, ContractError } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { ShadowBoundary } from './shadow-boundary.mjs';
import { TaskAwareBoundary } from './task-boundary.mjs';
import { ABSTAIN_CAPABILITIES } from './provider-binding.mjs';

/** Default is honest abstention: no key, network, synthetic probabilities or fabricated judgments. */
export function openLocalBoundary(env = process.env, { taskAware = env.REFLEXMESH_TASK_EVIDENCE === 'true' } = {}) {
  if (typeof taskAware !== 'boolean') throw new ContractError('Invalid task evidence mode');
  if (env.REFLEXMESH_TASK_EVIDENCE !== undefined && !['true','false'].includes(env.REFLEXMESH_TASK_EVIDENCE)) throw new ContractError('Invalid task evidence configuration');
  const kind = env.REFLEXMESH_PROVIDER ?? 'abstain';
  let provider, modelId, revision;
  if (kind === 'abstain') {
    provider = { id: 'abstain', capabilities: ABSTAIN_CAPABILITIES, evaluate: async () => { throw new Error('Decision provider not configured'); } };
    modelId = 'not-configured'; revision = 'abstain-v1';
  } else if (kind === 'jev') {
    if (env.REFLEXMESH_ALLOW_REMOTE !== 'true') throw new ContractError('Explicit REFLEXMESH_ALLOW_REMOTE=true required before sending tool arguments to a provider');
    if (!env.TYPESAFE_MODEL || !env.REFLEXMESH_PROVIDER_REVISION) throw new ContractError('Model and provider revision required');
    provider = new JevProvider({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL });
    modelId = env.TYPESAFE_MODEL; revision = env.REFLEXMESH_PROVIDER_REVISION;
  } else if (kind === 'deepseek') {
    if (env.REFLEXMESH_ALLOW_REMOTE !== 'true') throw new ContractError('Explicit REFLEXMESH_ALLOW_REMOTE=true required before sending tool arguments to a provider');
    if (!env.DEEPSEEK_MODEL || !env.REFLEXMESH_PROVIDER_REVISION?.trim()) throw new ContractError('Model and provider revision required');
    provider = new DeepSeekEstimateProvider({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL });
    modelId = env.DEEPSEEK_MODEL; revision = env.REFLEXMESH_PROVIDER_REVISION;
  } else throw new ContractError('Unsupported provider');
  const path = env.REFLEXMESH_DB ? resolve(env.REFLEXMESH_DB) : join(homedir(), '.reflexmesh', 'shadow.sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const kernel = new SqliteKernel(path);
  try {
    const Boundary = taskAware ? TaskAwareBoundary : ShadowBoundary;
    const boundary = new Boundary({ kernel, provider,
      binding: { providerId: provider.id, modelId, revision, calibrationRef: null, authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow' },
      pack: toolPreflightPack, tenantId: env.REFLEXMESH_TENANT ?? 'local', scope: env.REFLEXMESH_SCOPE ?? 'default',
    });
    return { boundary, kernel };
  } catch (e) { kernel.close(); throw e; }
}
