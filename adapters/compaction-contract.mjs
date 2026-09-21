import { createHash } from 'node:crypto';

export class CompactionError extends Error {
  constructor(code = 'compaction_failed') { super(`ReflexMesh compaction: ${code}`); this.code = code; }
}
const check = ok => { if (!ok) throw new CompactionError('invalid_plan'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, keys) {
  check(object(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')));
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const COMPACTION_TABLES = Object.freeze(['packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs']);
export const compactionTables = version => version >= 4
  ? [...COMPACTION_TABLES, 'audit_archive_batches', 'audit_archive_coverage'] : [...COMPACTION_TABLES];
export const compactionHash = value => createHash('sha256').update(value).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function validateLedgerSnapshot(value) {
  fields(value, ['ledgerSchemaVersion', 'logicalDigest', 'rowCounts', 'pages', 'journalMode']);
  check([1, 2, 3, 4].includes(value.ledgerSchemaVersion) && hash(value.logicalDigest));
  check(['wal', 'delete'].includes(value.journalMode));
  const all = compactionTables(value.ledgerSchemaVersion);
  const tables = all.slice(0, value.ledgerSchemaVersion === 1 ? 5 : value.ledgerSchemaVersion === 2 ? 6 : all.length);
  fields(value.rowCounts, all);
  check(all.every(table => tables.includes(table) ? integer(value.rowCounts[table]) : value.rowCounts[table] === null));
  fields(value.pages, ['pageSize', 'pageCount', 'freelistCount']);
  check(Object.values(value.pages).every(integer) && value.pages.pageSize >= 512
    && value.pages.pageSize <= 65536 && (value.pages.pageSize & (value.pages.pageSize - 1)) === 0
    && value.pages.pageCount > 0 && value.pages.freelistCount <= value.pages.pageCount
    && Number.isSafeInteger(value.pages.pageSize * value.pages.pageCount));
  return freeze(JSON.parse(JSON.stringify(value)));
}
export function validateCompactionPlan(value) {
  fields(value, ['schemaVersion', 'kind', 'createdAt', 'source', 'backup', 'snapshot',
    'quiescenceRequired', 'preservesAllRows', 'deleteRows', 'restoreAuthorized', 'retryAllowed']);
  check([1, 2].includes(value.schemaVersion) && value.kind === 'reflexmesh-ledger-compaction-plan');
  check(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt);
  fields(value.source, ['pathDigest', 'device', 'inode']);
  check(hash(value.source.pathDigest) && [value.source.device, value.source.inode]
    .every(v => typeof v === 'string' && /^(0|[1-9]\d{0,24})$/.test(v)));
  fields(value.backup, ['sha256', 'bytes', 'ledgerSchemaVersion']);
  check(hash(value.backup.sha256) && integer(value.backup.bytes) && value.backup.bytes > 0);
  validateLedgerSnapshot(value.snapshot);
  check(value.schemaVersion === (value.snapshot.ledgerSchemaVersion === 4 ? 2 : 1));
  check(value.backup.ledgerSchemaVersion === value.snapshot.ledgerSchemaVersion);
  check(value.quiescenceRequired === true && value.preservesAllRows === true
    && value.deleteRows === false && value.restoreAuthorized === false && value.retryAllowed === false);
  return freeze(JSON.parse(JSON.stringify(value)));
}
export function logicalEquivalent(a, b) {
  return a.ledgerSchemaVersion === b.ledgerSchemaVersion && a.logicalDigest === b.logicalDigest
    && compactionTables(a.ledgerSchemaVersion).every(table => a.rowCounts[table] === b.rowCounts[table]);
}
