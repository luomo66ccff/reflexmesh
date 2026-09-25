import { canonical, ContractError } from '../dist/index.js';
import { policyReplayReceipt } from './policy-replay.mjs';

const EFFECTS = ['allow', 'deny', 'confirm', 'escalate'];
const MAX_CHANGED_DETAILS = 100;

/** A local, policy-only page. The kernel has already read every record in one snapshot. */
export function policyImpactReceipt(page, candidatePack) {
  if (!page || !Array.isArray(page.records) || !page.anchorRecord)
    throw new ContractError('Impact scan is unavailable');
  const anchor = policyReplayReceipt(page.anchorRecord, candidatePack);
  const transitions = Object.fromEntries(EFFECTS.map(from => [from,
    Object.fromEntries(EFFECTS.map(to => [to, 0]))]));
  let effectChanged = 0, verdictChanged = 0;
  const changed = [];
  for (const { key, record } of page.records) {
    const receipt = policyReplayReceipt(record, candidatePack);
    transitions[receipt.original.effect][receipt.candidate.effect]++;
    const effectDiffers = receipt.original.effect !== receipt.candidate.effect;
    const verdictDiffers = canonical(receipt.original) !== canonical(receipt.candidate);
    if (effectDiffers) effectChanged++;
    if (verdictDiffers) {
      verdictChanged++;
      if (changed.length < MAX_CHANGED_DETAILS)
        changed.push({ key, original: receipt.original, candidate: receipt.candidate });
    }
  }
  const replayed = page.records.length;
  const excludedInScope = page.excluded.incomplete + page.excluded.unknown + page.excluded.noPrediction;
  if (replayed + excludedInScope !== page.matched)
    throw new ContractError('Impact coverage is inconsistent');
  const fullyClassified = page.excluded.unreadableEvidence === 0;
  return {
    hypothetical: true, executionAllowed: false,
    anchorKey: page.anchorKey, sourcePackDigest: page.sourcePackDigest,
    bindingDigest: page.bindingDigest, candidatePackDigest: anchor.candidatePackDigest,
    policyChanges: anchor.policyChanges,
    coverage: { scanned: page.scanned, matched: page.matched, replayed,
      excluded: page.excluded, after: page.after, scanLimit: page.scanLimit,
      hasMore: page.hasMore, nextCursor: page.nextCursor,
      completeLedgerSnapshot: page.after === '' && !page.hasMore && fullyClassified,
      fullyClassified },
    transitions, effectChanged, verdictChanged,
    changed, changedTruncated: verdictChanged > changed.length,
  };
}

export function formatPolicyImpact(report) {
  const c = report.coverage;
  const lines = [
    'ReflexMesh policy impact (read-only; key order, hypothetical)',
    `Anchor: ${JSON.stringify(report.anchorKey)}`,
    `Source pack digest: ${report.sourcePackDigest}`,
    `Binding digest: ${report.bindingDigest}`,
    `Candidate pack digest: ${report.candidatePackDigest}`,
    `Scanned: ${c.scanned}; in-scope: ${c.matched}; replayed: ${c.replayed}/${c.matched}`,
    `Excluded: ${JSON.stringify(c.excluded)}`,
    `Effect changed: ${report.effectChanged}/${c.replayed}; full verdict changed: ${report.verdictChanged}/${c.replayed}`,
    ...EFFECTS.flatMap(from => EFFECTS.filter(to => report.transitions[from][to] > 0)
      .map(to => `${from} -> ${to}: ${report.transitions[from][to]}`)),
    ...report.changed.map(item => `${JSON.stringify(item.key)}: ${item.original.effect} (${JSON.stringify(item.original.ruleId)}) -> ${item.candidate.effect} (${JSON.stringify(item.candidate.ruleId)})`),
    report.changedTruncated ? 'Changed-key details truncated to 100; counts remain complete for this page.' : '',
    c.completeLedgerSnapshot ? 'Coverage: complete key-order ledger snapshot for this scope.'
      : 'Coverage: partial or unclassified; do not treat this page as a full-history result.',
    c.nextCursor === null ? '' : `Next page: --after ${JSON.stringify(c.nextCursor)}`,
    'Separate pages are different snapshots; do not add them as one atomic total.',
    'hypothetical: true; execution allowed: false',
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}
