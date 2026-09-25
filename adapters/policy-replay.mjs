import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { canonical, ContractError } from '../dist/index.js';
import { replayPolicy } from './durable-mesh.mjs';

const MAX_CANDIDATE_BYTES = 128 * 1024;
const EFFECTS = new Set(['allow', 'deny', 'confirm', 'escalate']);

function policyChanges(record, candidatePack) {
  if (record.sourceConsistency === 'legacy_unverified') return { status: 'legacy_unverified' };
  const source = record.sourcePolicy;
  if (!source || !Array.isArray(source.rules) || typeof source.fallback !== 'string')
    throw new ContractError('Original policy structure is unavailable');
  const oldRules = new Map(source.rules.map(rule => [rule.id, rule]));
  const newRules = new Map(candidatePack.rules.map(rule => [rule.id, rule]));
  if (oldRules.size !== source.rules.length || newRules.size !== candidatePack.rules.length)
    throw new ContractError('Policy rule identity is invalid');
  const oldShared = source.rules.filter(rule => newRules.has(rule.id)).map(rule => rule.id);
  const newShared = candidatePack.rules.filter(rule => oldRules.has(rule.id)).map(rule => rule.id);
  const logic = rule => canonical({
    all: rule.all.map(condition => ({ answer: condition.answer, metric: condition.metric,
      op: condition.op, value: condition.value })), effect: rule.effect,
    ...(rule.directive === undefined ? {} : { directive: rule.directive }) });
  const rulesAdded = candidatePack.rules.length - newShared.length;
  const rulesRemoved = source.rules.length - oldShared.length;
  const rulesModified = oldShared.filter(id => logic(oldRules.get(id)) !== logic(newRules.get(id))).length;
  const sharedRuleOrderChanged = canonical(oldShared) !== canonical(newShared);
  const fallbackChanged = source.fallback !== candidatePack.fallback;
  return { status: 'verified', rulesAdded, rulesRemoved, rulesModified,
    sharedRuleOrderChanged, fallbackChanged,
    structureUnchanged: rulesAdded === 0 && rulesRemoved === 0 && rulesModified === 0
      && !sharedRuleOrderChanged && !fallbackChanged };
}

export async function readCandidatePack(path) {
  if (typeof path !== 'string' || !path || path.includes('\0'))
    throw new ContractError('A candidate JSON file is required');
  let file;
  try {
    const linkStat = await lstat(path);
    if (!linkStat.isFile() || linkStat.size < 1 || linkStat.size > MAX_CANDIDATE_BYTES)
      throw new ContractError('Candidate JSON file must be regular and 1 through 131072 bytes');
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CANDIDATE_BYTES)
      throw new ContractError('Candidate JSON file must be regular and 1 through 131072 bytes');
    // The extra byte detects growth after stat without an unbounded read.
    const bytes = Buffer.alloc(MAX_CANDIDATE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used < 1 || used > MAX_CANDIDATE_BYTES)
      throw new ContractError('Candidate JSON file must be regular and 1 through 131072 bytes');
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new ContractError('Candidate JSON must be a pack object');
    return candidate;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('Candidate JSON file is unavailable or malformed');
  } finally { await file?.close(); }
}

export function policyReplayReceipt(record, candidatePack) {
  if (!record) throw new ContractError('Unknown evidence key');
  if (!['verified', 'legacy_unverified'].includes(record.sourceConsistency))
    throw new ContractError('Original source consistency is unavailable');
  let replay;
  try { replay = replayPolicy(record, candidatePack); }
  catch (error) {
    if (error instanceof ContractError && ['Replay question contract mismatch', 'Recorded provider binding mismatch'].includes(error.message)) throw error;
    throw new ContractError('Completed prediction and valid matching candidate pack required');
  }
  const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
  const verdict = value => {
    if (!value || !EFFECTS.has(value.effect) || !safeText(value.ruleId)
      || value.directive !== undefined && !safeText(value.directive))
      throw new ContractError('Stored replay verdict is invalid');
    return { effect: value.effect, ruleId: value.ruleId,
      ...(value.directive === undefined ? {} : { directive: value.directive }) };
  };
  return {
    hypothetical: true,
    executionAllowed: false,
    originalSourceConsistency: record.sourceConsistency,
    policyChanges: policyChanges(record, candidatePack),
    original: verdict(replay.original),
    candidate: verdict(replay.candidate),
    candidatePackDigest: replay.candidatePackDigest,
  };
}

export function formatPolicyReplay(receipt) {
  const rule = value => `${JSON.stringify(value.ruleId)}${value.directive === undefined ? '' : `; directive: ${JSON.stringify(value.directive)}`}`;
  const changes = receipt.policyChanges;
  const changeLine = changes.status === 'verified'
    ? changes.structureUnchanged
      ? 'Policy changes: none in rules, order or fallback (pack metadata may differ)'
      : `Policy changes: ${changes.rulesModified} modified rule${changes.rulesModified === 1 ? '' : 's'}, `
        + `${changes.rulesAdded} added, ${changes.rulesRemoved} removed; `
        + `shared-rule order ${changes.sharedRuleOrderChanged ? 'changed' : 'unchanged'}; `
        + `fallback ${changes.fallbackChanged ? 'changed' : 'unchanged'}`
    : 'Policy changes: unavailable; legacy original pack body absent';
  return [
    'ReflexMesh policy replay (read-only)',
    `Original source consistency: ${receipt.originalSourceConsistency === 'verified'
      ? 'verified against local bound pack (not authenticated)'
      : 'legacy_unverified; original pack body unavailable'}`,
    changeLine,
    'Policy changes describe structure, not which edit caused a decision.',
    `Decision change: ${receipt.original.effect} -> ${receipt.candidate.effect}`,
    `Original: ${receipt.original.effect}; rule: ${rule(receipt.original)}`,
    `Candidate: ${receipt.candidate.effect}; rule: ${rule(receipt.candidate)}`,
    `Candidate pack digest: ${receipt.candidatePackDigest}`,
    'hypothetical: true',
    'execution allowed: false',
  ].join('\n') + '\n';
}
