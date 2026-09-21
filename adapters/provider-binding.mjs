import { createHash } from 'node:crypto';
import { canonical, ContractError, snapshot } from '../dist/index.js';
import { snapshotProvider, validateProviderCapabilities } from '../dist/core/provider-capabilities.js';

export const ABSTAIN_CAPABILITIES = validateProviderCapabilities({
  schemaVersion: 1, resultContract: 'probabilistic-v1', probabilitySemantics: 'none',
  answers: { noul: 'unsupported', choice: 'unsupported', score: 'unsupported' },
  limits: { maxStateBytes: 1, maxQuestions: 1, maxChoicesPerQuestion: 1 },
});

/** Bind one validated declaration to the selected provider and deployment identity. */
export function normalizeProviderBinding(provider, binding) {
  const captured = snapshotProvider(provider);
  const capabilities = captured.capabilities;
  const original = snapshot(binding);
  for (const name of ['providerId', 'modelId', 'revision', 'authorizationRevision', 'toolsetRevision']) {
    if (typeof original?.[name] !== 'string' || !original[name].trim())
      throw new ContractError(`Missing deployment ${name}`);
  }
  if (original.providerId !== captured.id) throw new ContractError('Provider binding mismatch');
  if (captured.model !== undefined && original.modelId !== captured.model)
    throw new ContractError('Provider model binding mismatch');
  const capabilitiesDigest = createHash('sha256').update(canonical(capabilities)).digest('hex');
  if (original.capabilitiesDigest !== undefined && original.capabilitiesDigest !== capabilitiesDigest)
    throw new ContractError('Provider capabilities binding mismatch');
  return snapshot({ ...original, capabilitiesDigest });
}
