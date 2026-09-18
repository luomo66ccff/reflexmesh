import { probability, ContractError } from '../core/validation.js';
export interface SpeculationCandidate {
  readonly id: string;
  readonly probability: number;
  readonly latencySavedMs: number;
  readonly costUsd: number;
  readonly riskPenaltyUsd: number;
  readonly effect: 'read' | 'write' | 'destructive';
  readonly idempotent: boolean;
  readonly speculatable: boolean;
  readonly authorized: boolean;
  readonly sensitive: boolean;
}
/** Planner ONLY. Metadata must come from trusted tool registration + host authorization. */
export function planSpeculation(candidates: readonly SpeculationCandidate[], options: { latencyValueUsdPerMs: number; budgetUsd: number; maxParallel: number }): readonly (SpeculationCandidate & { expectedNetUsd: number })[] {
  for (const n of [options.latencyValueUsdPerMs, options.budgetUsd]) if (!Number.isFinite(n) || n < 0) throw new ContractError('Invalid budget');
  if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 0) throw new ContractError('Invalid parallelism');
  const seen = new Set<string>();
  const scored = candidates.map(c => {
    if (!c.id || seen.has(c.id)) throw new ContractError('Duplicate candidate'); seen.add(c.id);
    probability(c.probability);
    for (const n of [c.latencySavedMs, c.costUsd, c.riskPenaltyUsd]) if (!Number.isFinite(n) || n < 0) throw new ContractError('Invalid candidate cost');
    return { ...c, expectedNetUsd: c.probability * c.latencySavedMs * options.latencyValueUsdPerMs - c.costUsd - c.riskPenaltyUsd };
  }).filter(c => c.authorized && c.effect === 'read' && c.idempotent && c.speculatable && !c.sensitive && c.expectedNetUsd > 0)
    .sort((a, b) => b.expectedNetUsd - a.expectedNetUsd || a.id.localeCompare(b.id));
  // Greedy baseline, intentionally not described as globally optimal knapsack scheduling.
  const selected: (SpeculationCandidate & { expectedNetUsd: number })[] = [];
  let remaining = options.budgetUsd;
  for (const c of scored) if (selected.length < options.maxParallel && c.costUsd <= remaining + 1e-12) { selected.push(c); remaining -= c.costUsd; }
  return selected;
}
