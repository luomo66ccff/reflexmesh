import { validateLedgerSnapshot, logicalEquivalent } from './compaction-contract.mjs';

export class AuditArchiveError extends Error {
  constructor(code = 'archive_unverified') { super(`ReflexMesh audit archive: ${code}`); this.code = code; }
}
export const archiveCheck = (ok, code = 'invalid_plan') => { if (!ok) throw new AuditArchiveError(code); };
export const archiveHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const archiveCount = value => Number.isSafeInteger(value) && value >= 0;
export const archiveSeq = value => typeof value === 'string' && /^-?(0|[1-9]\d{0,18})$/.test(value)
  && value !== '-0' && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
export function archiveFields(value, keys) {
  archiveCheck(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  archiveCheck(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')));
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
export function validateArchivePreview(value) {
  archiveFields(value, ['sourceSnapshot', 'selection', 'previousBatchId']);
  validateLedgerSnapshot(value.sourceSnapshot);
  archiveCheck([3, 4].includes(value.sourceSnapshot.ledgerSchemaVersion));
  archiveCheck(value.previousBatchId === null || archiveHash(value.previousBatchId));
  const s = value.selection;
  archiveFields(s, ['cutoffAt', 'highwaterSeq', 'rowCount', 'auditDigest', 'runCount', 'coverageDigest']);
  archiveCheck(archiveCount(s.cutoffAt) && archiveSeq(s.highwaterSeq)
    && BigInt(s.highwaterSeq) > 0n
    && archiveCount(s.rowCount) && s.rowCount > 0 && s.rowCount <= 10000
    && archiveCount(s.runCount) && s.runCount > 0 && s.runCount <= s.rowCount
    && archiveHash(s.auditDigest) && archiveHash(s.coverageDigest));
  return frozen(JSON.parse(JSON.stringify(value)));
}
export function validateAuditArchivePlan(value) {
  archiveFields(value, ['schemaVersion', 'kind', 'createdAt', 'source', 'backup', 'preview', 'maxRows',
    'quiescenceRequired', 'deleteAuditRows', 'preserveExecutionGuards', 'restoreAuthorized', 'retryAllowed']);
  archiveCheck(value.schemaVersion === 1 && value.kind === 'reflexmesh-audit-archive-plan');
  archiveCheck(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt);
  archiveFields(value.source, ['pathDigest', 'device', 'inode']);
  archiveCheck(archiveHash(value.source.pathDigest) && [value.source.device, value.source.inode]
    .every(v => typeof v === 'string' && /^(0|[1-9]\d{0,24})$/.test(v)));
  archiveFields(value.backup, ['sha256', 'bytes', 'ledgerSchemaVersion']);
  archiveCheck(archiveHash(value.backup.sha256) && archiveCount(value.backup.bytes) && value.backup.bytes > 0);
  validateArchivePreview(value.preview);
  archiveCheck(value.backup.ledgerSchemaVersion === value.preview.sourceSnapshot.ledgerSchemaVersion
    && archiveCount(value.maxRows) && value.maxRows >= value.preview.selection.rowCount && value.maxRows <= 10000);
  archiveCheck(value.quiescenceRequired === true && value.deleteAuditRows === true && value.preserveExecutionGuards === true
    && value.restoreAuthorized === false && value.retryAllowed === false);
  return frozen(JSON.parse(JSON.stringify(value)));
}
export function validateArchiveReceipt(receipt, plan, batchId) {
  archiveCheck(receipt && receipt.batchId === batchId, 'invalid_receipt');
  const before = validateLedgerSnapshot(receipt.before), after = validateLedgerSnapshot(receipt.after);
  archiveCheck(logicalEquivalent(before, plan.preview.sourceSnapshot) && after.ledgerSchemaVersion === 4
    && receipt.archivedRows === plan.preview.selection.rowCount && receipt.archivedRuns === plan.preview.selection.runCount
    && receipt.coverageDigest === plan.preview.selection.coverageDigest, 'invalid_receipt');
  archiveCheck(['packs', 'runs', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs'].every(table =>
    before.rowCounts[table] === after.rowCounts[table]) && before.rowCounts.audit - receipt.archivedRows === after.rowCounts.audit
    && after.rowCounts.audit_archive_batches === (before.rowCounts.audit_archive_batches ?? 0) + 1
    && after.rowCounts.audit_archive_coverage === (before.rowCounts.audit_archive_coverage ?? 0) + receipt.archivedRuns, 'invalid_receipt');
  return { batchId, archivedRows: receipt.archivedRows, archivedRuns: receipt.archivedRuns,
    coverageDigest: receipt.coverageDigest, before, after };
}
