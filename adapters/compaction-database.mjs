import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recognizedSchema } from './backup-database.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { inspectAuditArchiveMetadata } from './audit-archive-schema.mjs';

const TABLES = Object.freeze([
  { name: 'packs', since: 1, columns: ['id', 'version', 'digest', 'body'], key: ['id', 'version'] },
  { name: 'runs', since: 1, columns: ['key', 'request_digest', 'state', 'epoch', 'owner', 'lease_until', 'evidence', 'result'], key: ['key'] },
  { name: 'audit', since: 1, columns: ['seq', 'run_key', 'kind', 'details', 'at'], key: ['seq'] },
  { name: 'observations', since: 1, columns: ['run_key', 'id', 'body'], key: ['run_key', 'id'] },
  { name: 'labels', since: 1, columns: ['run_key', 'id', 'body'], key: ['run_key', 'id'] },
  { name: 'recovery_reviews', since: 2, columns: ['run_key', 'id', 'body', 'digest', 'applied_epoch', 'at'], key: ['run_key', 'id'] },
  { name: 'claude_hook_pairs', since: 3, columns: ['key', 'token', 'call_digest', 'action_digest', 'deployment_digest', 'request_digest', 'state', 'reason_code'], key: ['key'] },
  { name: 'audit_archive_batches', since: 4, columns: ['id', 'previous_id', 'archive_sha256', 'archive_bytes', 'source_schema_version', 'source_logical_digest', 'cutoff_at', 'highwater_seq', 'row_count', 'audit_digest', 'committed_at'], key: ['id'] },
  { name: 'audit_archive_coverage', since: 4, columns: ['run_key', 'batch_id', 'row_count', 'min_seq', 'max_seq', 'audit_digest'], key: ['run_key', 'batch_id'] },
]);
const versionTables = version => TABLES.filter(table => table.since < 4 || version >= 4);
const names = version => versionTables(version).map(table => table.name);
const INTEGER_COLUMNS = new Set(['runs.epoch', 'runs.lease_until', 'audit.seq', 'audit.at',
  'recovery_reviews.applied_epoch', 'recovery_reviews.at',
  ...['archive_bytes', 'source_schema_version', 'cutoff_at', 'highwater_seq', 'row_count', 'committed_at'].map(column => `audit_archive_batches.${column}`),
  ...['row_count', 'min_seq', 'max_seq'].map(column => `audit_archive_coverage.${column}`)]);
const HASH = /^[a-f0-9]{64}$/;
const INVALID = 'compaction_snapshot_invalid';

export class CompactionDatabaseError extends Error {
  constructor(code) { super(code); this.name = 'CompactionDatabaseError'; this.code = code; }
}
const fail = code => { throw new CompactionDatabaseError(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'));
}
function safeFile(path, code) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 1000 && isAbsolute(path)
    && !/[\u0000-\u001f\u007f-\u009f]/.test(path) && !/^[\\/]{2}/.test(path)
    && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(':')), code);
  try {
    const stat = lstatSync(path, { bigint: true });
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && stat.size >= 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER), code);
    return stat;
  } catch (error) { if (error instanceof CompactionDatabaseError) throw error; fail(code); }
}
function frameBytes(hash, bytes) {
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}
function frame(hash, value) { frameBytes(hash, Buffer.from(value, 'utf8')); }
function valueFrame(hash, value) {
  if (value === null) { frame(hash, 'null'); return; }
  if (typeof value === 'bigint') { frame(hash, 'integer'); frame(hash, value.toString()); return; }
  check(value instanceof Uint8Array, 'compaction_content_invalid');
  frame(hash, 'text-bytes'); frameBytes(hash, value);
}
function pragmaCount(db, name) {
  const value = db.prepare(`PRAGMA ${name}`).get()?.[name];
  check(safeCount(value), 'compaction_integrity_failed');
  return value;
}
function pages(db) {
  const pageSize = pragmaCount(db, 'page_size');
  const pageCount = pragmaCount(db, 'page_count');
  const freelistCount = pragmaCount(db, 'freelist_count');
  check(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0
    && pageCount >= 1 && freelistCount <= pageCount
    && Number.isSafeInteger(pageSize * pageCount), 'compaction_integrity_failed');
  return Object.freeze({ pageSize, pageCount, freelistCount });
}
/** Caller owns the connection and transaction; never opens another source connection. */
export function snapshotLedgerConnection(db) {
  let version;
  try { version = recognizedSchema(db); }
  catch { fail('compaction_schema_unrecognized'); }
  const journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
  check(journalMode === 'wal' || journalMode === 'delete', 'compaction_journal_unsupported');
  const encoding = db.prepare('PRAGMA encoding').get()?.encoding;
  check(['UTF-8', 'UTF-16le', 'UTF-16be'].includes(encoding), 'compaction_content_invalid');
  let checks = 0;
  for (const row of db.prepare('PRAGMA integrity_check').iterate()) {
    checks++;
    check(checks === 1 && row.integrity_check === 'ok', 'compaction_integrity_failed');
  }
  check(checks === 1, 'compaction_integrity_failed');
  check(db.prepare('PRAGMA foreign_key_check').get() === undefined, 'compaction_foreign_keys_failed');
  if (version === 4) {
    try { inspectAuditArchiveMetadata(db, version); } catch { fail('compaction_schema_unrecognized'); }
  }
  const physicalPages = pages(db);
  const hash = createHash('sha256'), rowCounts = {};
  frame(hash, version >= 4 ? 'reflexmesh-ledger-logical-v3' : 'reflexmesh-ledger-logical-v2'); frame(hash, String(version)); frame(hash, encoding);
  for (const table of versionTables(version)) {
    if (table.since > version) { rowCounts[table.name] = null; continue; }
    frame(hash, table.name);
    for (const column of table.columns) {
      frame(hash, column);
      frame(hash, INTEGER_COLUMNS.has(`${table.name}.${column}`) ? 'INTEGER' : 'TEXT');
    }
    const columns = table.columns.map(column => INTEGER_COLUMNS.has(`${table.name}.${column}`)
      ? `"${column}"` : `CAST("${column}" AS BLOB) AS "${column}"`).join(',');
    const order = table.key.map(column => `"${table.name}"."${column}"`).join(',');
    const statement = db.prepare(`SELECT ${columns} FROM "${table.name}" ORDER BY ${order}`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const row of statement.iterate()) {
      check(count < Number.MAX_SAFE_INTEGER, 'compaction_content_invalid');
      count++;
      frame(hash, 'row');
      for (const column of table.columns) valueFrame(hash, row[column]);
    }
    frame(hash, 'row-count'); frame(hash, String(count));
    rowCounts[table.name] = count;
  }
  return Object.freeze({ ledgerSchemaVersion: version, logicalDigest: hash.digest('hex'),
    rowCounts: Object.freeze(rowCounts), pages: physicalPages, journalMode });
}
function validExpected(value) {
  check(exact(value, ['ledgerSchemaVersion', 'logicalDigest', 'rowCounts', 'pages', 'journalMode'])
    && [1, 2, 3, 4].includes(value.ledgerSchemaVersion)
    && typeof value.logicalDigest === 'string' && HASH.test(value.logicalDigest)
    && ['wal', 'delete'].includes(value.journalMode), INVALID);
  check(exact(value.rowCounts, names(value.ledgerSchemaVersion)) && exact(value.pages, ['pageSize', 'pageCount', 'freelistCount']), INVALID);
  for (const table of versionTables(value.ledgerSchemaVersion)) {
    const count = value.rowCounts[table.name];
    check(table.since <= value.ledgerSchemaVersion ? safeCount(count) : count === null, INVALID);
  }
  const { pageSize, pageCount, freelistCount } = value.pages;
  check(safeCount(pageSize) && pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0
    && safeCount(pageCount) && pageCount >= 1 && safeCount(freelistCount) && freelistCount <= pageCount
    && Number.isSafeInteger(pageSize * pageCount), INVALID);
  return Object.freeze({ ledgerSchemaVersion: value.ledgerSchemaVersion, logicalDigest: value.logicalDigest,
    rowCounts: Object.freeze(Object.fromEntries(names(value.ledgerSchemaVersion).map(name => [name, value.rowCounts[name]]))),
    pages: Object.freeze({ pageSize, pageCount, freelistCount }), journalMode: value.journalMode });
}
function sameRows(left, right) {
  return names(left.ledgerSchemaVersion).every(name => left.rowCounts[name] === right.rowCounts[name]);
}
function sameContent(left, right) {
  return left.ledgerSchemaVersion === right.ledgerSchemaVersion
    && left.logicalDigest === right.logicalDigest && sameRows(left, right);
}
function sameBefore(left, right) {
  return sameContent(left, right) && left.journalMode === right.journalMode
    && left.pages.pageSize === right.pages.pageSize
    && left.pages.pageCount === right.pages.pageCount
    && left.pages.freelistCount === right.pages.freelistCount;
}

/** One read-only transaction; never migrates or rewrites historical rows. */
export function ledgerSnapshot(path) {
  safeFile(path, 'compaction_source_invalid');
  let db, active = false, result, failure = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('BEGIN'); active = true;
    result = snapshotLedgerConnection(db);
  } catch (error) { failure = error instanceof CompactionDatabaseError ? error : new CompactionDatabaseError('compaction_failed'); }
  finally {
    if (active) try { db.exec('ROLLBACK'); } catch { failure ??= new CompactionDatabaseError('compaction_failed'); }
    try { db?.close(); } catch { failure ??= new CompactionDatabaseError('compaction_failed'); }
  }
  if (failure) throw failure;
  return result;
}

/** The EXCLUSIVE connection remains open across COMMIT, VACUUM and post-verification. */
export async function compactLedger(path, options = {}) {
  try { assertSqliteWalRuntime(); } catch { fail('compaction_runtime_unsupported'); }
  check(exact(options, ['expectedSnapshot', 'backupPath'])
    || exact(options, ['expectedSnapshot', 'backupPath', 'onStage']), INVALID);
  const { expectedSnapshot, backupPath, onStage } = options;
  const expected = validExpected(expectedSnapshot);
  check(onStage === undefined || typeof onStage === 'function', INVALID);
  safeFile(path, 'compaction_source_invalid');
  safeFile(backupPath, 'compaction_backup_invalid');
  check(path !== backupPath, 'compaction_backup_invalid');
  let db, active = false, vacuumStarted = false, result, failure = null;
  try {
    db = new DatabaseSync(path);
    check(db.prepare('PRAGMA main.locking_mode=EXCLUSIVE').get()?.locking_mode === 'exclusive', 'compaction_lock_failed');
    db.exec('PRAGMA busy_timeout=0');
    db.exec('BEGIN EXCLUSIVE'); active = true;
    const before = snapshotLedgerConnection(db);
    check(sameBefore(before, expected), 'compaction_stale_snapshot');
    const backup = ledgerSnapshot(backupPath);
    check(backup.journalMode === 'delete' && sameContent(before, backup), 'compaction_backup_mismatch');
    db.exec('COMMIT'); active = false;
    check(db.prepare('PRAGMA main.locking_mode').get()?.locking_mode === 'exclusive', 'compaction_lock_failed');
    if (onStage) await onStage('locked');
    if (onStage) await onStage('before-vacuum');
    vacuumStarted = true;
    db.exec('VACUUM');
    if (onStage) await onStage('after-vacuum');
    db.exec('BEGIN'); active = true;
    const after = snapshotLedgerConnection(db);
    check(sameContent(before, after) && after.journalMode === before.journalMode
      && after.pages.pageSize === before.pages.pageSize, 'compaction_content_changed');
    db.exec('COMMIT'); active = false;
    check(db.prepare('PRAGMA main.locking_mode').get()?.locking_mode === 'exclusive', 'compaction_lock_failed');
    result = Object.freeze({ before, after, logicalContentPreserved: true });
  } catch (error) {
    failure = vacuumStarted ? new CompactionDatabaseError('compaction_uncertain')
      : error instanceof CompactionDatabaseError ? error : new CompactionDatabaseError('compaction_failed');
  } finally {
    if (active) try { db.exec('ROLLBACK'); } catch { failure ??= new CompactionDatabaseError(vacuumStarted ? 'compaction_uncertain' : 'compaction_failed'); }
    try { db?.close(); } catch { failure ??= new CompactionDatabaseError(vacuumStarted ? 'compaction_uncertain' : 'compaction_failed'); }
  }
  if (failure) throw failure;
  return result;
}
