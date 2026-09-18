import { ContractError, record, snapshot } from '../dist/index.js';

export const RECOVERY_RESOLUTIONS = Object.freeze([
  'unresolved', 'confirmed_succeeded', 'confirmed_failed', 'confirmed_not_executed',
]);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const check = (ok, message) => { if (!ok) throw new ContractError(message); };

/** Local operator declaration, not external attestation, tool authorization or a truth label. */
export function validateRecoveryReview(input) {
  const value = snapshot(input);
  const keys = ['schemaVersion','id','runKey','expectedEpoch','inputDigest','resolution',
    'evidenceDigest','evidenceRef','actorRef','reason','quiescent'];
  check(record(value) && Object.keys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value, k)), 'Invalid recovery review fields');
  check(value.schemaVersion === 1, 'Unsupported recovery review schema');
  check(text(value.id, 128) && text(value.runKey, 1024), 'Invalid recovery review identity');
  check(Number.isSafeInteger(value.expectedEpoch) && value.expectedEpoch > 0
    && value.expectedEpoch < Number.MAX_SAFE_INTEGER, 'Invalid recovery epoch');
  check(hex(value.inputDigest) && hex(value.evidenceDigest), 'Invalid recovery digest');
  check(RECOVERY_RESOLUTIONS.includes(value.resolution), 'Invalid recovery resolution');
  check(text(value.evidenceRef, 512) && text(value.actorRef, 128) && text(value.reason, 512), 'Invalid recovery provenance');
  check(value.quiescent === true, 'Explicit quiescence confirmation required');
  return value;
}

export function validateLabelEnvelope(input) {
  const label = snapshot(input);
  const keys = ['id','questionId','value','provenance','sourceRef'];
  check(record(label) && Object.keys(label).length === keys.length
    && keys.every(k => Object.hasOwn(label, k)), 'Invalid label fields');
  check(text(label.id, 128) && text(label.questionId, 128) && text(label.sourceRef, 512)
    && ['human','test-oracle'].includes(label.provenance), 'Independent label provenance required');
  return label;
}

/** A label is a target class, not a model's probability or expected ordinal score. */
export function validateLabelValue(question, value) {
  if (question.type === 'noul') {
    check(value === 0 || value === 1, 'Binary label must be 0 or 1');
  } else if (question.type === 'choice') {
    check(typeof value === 'string' && Object.hasOwn(question.criteria, value), 'Unknown choice label');
  } else if (question.type === 'score') {
    check(Number.isSafeInteger(value) && value >= 0 && value < question.criteria.length, 'Ordinal label must be a rubric index');
  } else throw new ContractError('Unsupported label question');
}
