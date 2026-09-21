import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ledgerSnapshot, snapshotLedgerConnection } from './compaction-database.mjs';
import { logicalEquivalent, validateLedgerSnapshot } from './compaction-contract.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { AUDIT_ARCHIVE_TABLE_SQL, inspectAuditArchiveMetadata } from './audit-archive-schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_ROWID = 9223372036854775807n;
const decoder = new TextDecoder('utf-8', { fatal: true });
const retainedTables = Object.freeze([
  { name: 'packs', columns: ['id', 'version', 'digest', 'body'], key: ['id', 'version'] },
  { name: 'runs', columns: ['key', 'request_digest', 'state', 'epoch', 'owner', 'lease_until', 'evidence', 'result'], key: ['key'] },
  { name: 'audit', columns: ['seq', 'run_key', 'kind', 'details', 'at'], key: ['seq'] },
  { name: 'observations', columns: ['run_key', 'id', 'body'], key: ['run_key', 'id'] },
  { name: 'labels', columns: ['run_key', 'id', 'body'], key: ['run_key', 'id'] },
  { name: 'recovery_reviews', columns: ['run_key', 'id', 'body', 'digest', 'applied_epoch', 'at'], key: ['run_key', 'id'] },
  { name: 'claude_hook_pairs', columns: ['key', 'token', 'call_digest', 'action_digest', 'deployment_digest', 'request_digest', 'state', 'reason_code'], key: ['key'] },
  { name: 'audit_archive_batches', columns: ['id', 'previous_id', 'archive_sha256', 'archive_bytes', 'source_schema_version', 'source_logical_digest', 'cutoff_at', 'highwater_seq', 'row_count', 'audit_digest', 'committed_at'], key: ['id'] },
  { name: 'audit_archive_coverage', columns: ['run_key', 'batch_id', 'row_count', 'min_seq', 'max_seq', 'audit_digest'], key: ['run_key', 'batch_id'] },
]);
const integers = new Set(['runs.epoch', 'runs.lease_until', 'audit.seq', 'audit.at',
  'recovery_reviews.applied_epoch', 'recovery_reviews.at', 'audit_archive_batches.archive_bytes',
  'audit_archive_batches.source_schema_version', 'audit_archive_batches.cutoff_at',
  'audit_archive_batches.highwater_seq', 'audit_archive_batches.row_count',
  'audit_archive_batches.committed_at', 'audit_archive_coverage.row_count',
  'audit_archive_coverage.min_seq', 'audit_archive_coverage.max_seq']);

export class AuditArchiveDatabaseError extends Error {
  constructor(code) { super(code); this.name = 'AuditArchiveDatabaseError'; this.code = code; }
}
const fail = code => { throw new AuditArchiveDatabaseError(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'));
}
function safeFile(path, code) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 1000 && isAbsolute(path)
    && !/[\u0000-\u001f\u007f-\u009f]/.test(path) && !/^[\\/]{2}/.test(path)
    && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(':')), code);
  try {
    const stat = lstatSync(path, { bigint: true });
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && stat.size > 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER), code);
  } catch (error) { if (error instanceof AuditArchiveDatabaseError) throw error; fail(code); }
}
function differentFiles(source, backup) {
  try {
    const left = realpathSync(source), right = realpathSync(backup);
    return process.platform === 'win32' ? left.toLowerCase() !== right.toLowerCase() : left !== right;
  } catch { return false; }
}
function bytesFrame(hash, bytes) { hash.update(`${bytes.length}:`); hash.update(bytes); }
function frame(hash, value) { bytesFrame(hash, Buffer.from(value, 'utf8')); }
function typed(hash, value) {
  if (value === null) { frame(hash, 'null'); return; }
  if (typeof value === 'bigint') { frame(hash, 'integer'); frame(hash, value.toString()); return; }
  check(value instanceof Uint8Array, 'archive_content_invalid');
  frame(hash, 'text-bytes'); bytesFrame(hash, value);
}
function validKeyBytes(bytes) {
  check(bytes instanceof Uint8Array, 'archive_run_key_invalid');
  let key;
  try { key = decoder.decode(bytes); } catch { fail('archive_run_key_invalid'); }
  check(key.length > 0 && key.length <= 1024
    && Buffer.from(key, 'utf8').equals(Buffer.from(bytes)), 'archive_run_key_invalid');
  return key;
}
function decimal(value, code) {
  check(typeof value === 'string' && value.length <= 19 && DECIMAL.test(value), code);
  const result = BigInt(value);
  check(result <= MAX_ROWID, code);
  return result;
}
function limitedCount(value, code) {
  check(typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), code);
  return Number(value);
}
function versionedSnapshot(db) {
  let encoding;
  try { encoding = db.prepare('PRAGMA encoding').get()?.encoding; }
  catch { fail('archive_encoding_unsupported'); }
  check(encoding === 'UTF-8', 'archive_encoding_unsupported');
  let result;
  try { result = snapshotLedgerConnection(db); }
  catch { fail('archive_source_unrecognized'); }
  check(result.ledgerSchemaVersion === 3 || result.ledgerSchemaVersion === 4, 'archive_schema_unsupported');
  return result;
}
function backupEquivalent(source, backupPath) {
  let archived;
  try { archived = ledgerSnapshot(backupPath); }
  catch { fail('archive_backup_invalid'); }
  check(logicalEquivalent(source, archived), 'archive_backup_mismatch');
}
function auditHash() { const hash = createHash('sha256'); frame(hash, 'reflexmesh-audit-rows-v1'); return hash; }
function auditRow(hash, row) {
  frame(hash, 'row'); typed(hash, row.seq); typed(hash, row.raw_key);
  typed(hash, row.kind); typed(hash, row.details); typed(hash, row.at);
}
function doneAuditHash(hash, count) { frame(hash, 'row-count'); frame(hash, String(count)); return hash.digest('hex'); }
function auditRows(db, where, params) {
  const statement = db.prepare(`SELECT seq,CAST(run_key AS BLOB) AS raw_key,
    CAST(kind AS BLOB) AS kind,CAST(details AS BLOB) AS details,at
    FROM audit WHERE ${where} ORDER BY seq`);
  statement.setReadBigInts(true);
  return statement.iterate(...params);
}
function highwater(db) {
  const statement = db.prepare('SELECT MAX(seq) AS seq FROM audit');
  statement.setReadBigInts(true);
  const value = statement.get()?.seq;
  check(typeof value === 'bigint' && value > 0n && value <= MAX_ROWID, 'archive_selection_empty');
  return value;
}
function selection(db, cutoffAt, maxRows) {
  const anchor = highwater(db), hash = auditHash(), groups = new Map();
  const statement = db.prepare(`SELECT seq,CAST(run_key AS BLOB) AS raw_key,
    CAST(kind AS BLOB) AS kind,CAST(details AS BLOB) AS details,at
    FROM audit WHERE at<? AND seq<? ORDER BY seq LIMIT ?`);
  statement.setReadBigInts(true);
  let rowCount = 0;
  for (const row of statement.iterate(BigInt(cutoffAt), anchor, maxRows + 1)) {
    check(++rowCount <= maxRows, 'archive_selection_over_limit');
    check(typeof row.seq === 'bigint' && row.seq > 0n && row.seq < anchor
      && typeof row.at === 'bigint' && row.kind instanceof Uint8Array
      && row.details instanceof Uint8Array, 'archive_content_invalid');
    const runKey = validKeyBytes(row.raw_key);
    auditRow(hash, row);
    let group = groups.get(runKey);
    if (!group) { group = { runKey, rawKey: Buffer.from(row.raw_key), hash: auditHash(), rowCount: 0,
      minSeq: row.seq, maxSeq: row.seq }; groups.set(runKey, group); }
    auditRow(group.hash, row);
    group.rowCount++; group.maxSeq = row.seq;
  }
  check(rowCount > 0, 'archive_selection_empty');
  const coverage = [...groups.values()].sort((a, b) => Buffer.compare(a.rawKey, b.rawKey))
    .map(group => ({ runKey: group.runKey, rawKey: group.rawKey, rowCount: group.rowCount,
      minSeq: group.minSeq, maxSeq: group.maxSeq,
      auditDigest: doneAuditHash(group.hash, group.rowCount) }));
  const coverageHash = createHash('sha256'); frame(coverageHash, 'reflexmesh-audit-coverage-v1');
  for (const item of coverage) {
    frame(coverageHash, 'run'); bytesFrame(coverageHash, item.rawKey);
    frame(coverageHash, String(item.rowCount)); frame(coverageHash, item.minSeq.toString());
    frame(coverageHash, item.maxSeq.toString()); frame(coverageHash, item.auditDigest);
  }
  frame(coverageHash, 'run-count'); frame(coverageHash, String(coverage.length));
  return { public: Object.freeze({ cutoffAt, highwaterSeq: anchor.toString(), rowCount,
    auditDigest: doneAuditHash(hash, rowCount), runCount: coverage.length,
    coverageDigest: coverageHash.digest('hex') }), coverage };
}

function countQuery(db, sql, ...params) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return limitedCount(statement.get(...params)?.count, 'archive_history_invalid');
}
function metadataState(db, version) {
  try { return inspectAuditArchiveMetadata(db, version); }
  catch { fail('archive_history_invalid'); }
}

function retainedDigest(db, version, cutoffAt, highwaterSeq, batchId) {
  const hash = createHash('sha256'); frame(hash, 'reflexmesh-audit-retained-v1');
  for (const table of retainedTables) {
    frame(hash, table.name);
    for (const column of table.columns) {
      frame(hash, column);
      frame(hash, integers.has(`${table.name}.${column}`) ? 'INTEGER' : 'TEXT');
    }
    if (version === 3 && table.name.startsWith('audit_archive_')) {
      frame(hash, 'row-count'); frame(hash, '0');
      continue;
    }
    const columns = table.columns.map(column => integers.has(`${table.name}.${column}`)
      ? `"${column}"` : `CAST("${column}" AS BLOB) AS "${column}"`).join(',');
    const order = table.key.map(column => `"${table.name}"."${column}"`).join(',');
    const filter = table.name === 'audit' ? 'WHERE NOT(at<? AND seq<?)'
      : table.name === 'audit_archive_batches' ? 'WHERE id<>?'
        : table.name === 'audit_archive_coverage' ? 'WHERE batch_id<>?' : '';
    const params = table.name === 'audit' ? [BigInt(cutoffAt), highwaterSeq]
      : table.name.startsWith('audit_archive_') ? [batchId] : [];
    const statement = db.prepare(`SELECT ${columns} FROM "${table.name}" ${filter} ORDER BY ${order}`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const row of statement.iterate(...params)) {
      check(count < Number.MAX_SAFE_INTEGER, 'archive_content_invalid');
      count++; frame(hash, 'row');
      for (const column of table.columns) typed(hash, row[column]);
    }
    frame(hash, 'row-count'); frame(hash, String(count));
  }
  return hash.digest('hex');
}

function requiredOptions(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && Object.hasOwn(descriptors[key], 'value'))
    && required.every(key => Object.hasOwn(descriptors, key));
}
function optionLimit(options) {
  const maxRows = Object.hasOwn(options, 'maxRows') ? options.maxRows : 10000;
  check(safeInt(maxRows) && maxRows >= 1 && maxRows <= 10000, 'archive_options_invalid');
  return maxRows;
}
function checkedPreview(value, maxRows) {
  check(exact(value, ['sourceSnapshot', 'selection', 'previousBatchId']), 'archive_preview_invalid');
  let sourceSnapshot;
  try { sourceSnapshot = validateLedgerSnapshot(value.sourceSnapshot); }
  catch { fail('archive_preview_invalid'); }
  check([3, 4].includes(sourceSnapshot.ledgerSchemaVersion)
    && exact(value.selection, ['cutoffAt', 'highwaterSeq', 'rowCount', 'auditDigest', 'runCount', 'coverageDigest']),
  'archive_preview_invalid');
  const selected = value.selection;
  check(safeInt(selected.cutoffAt) && selected.rowCount >= 1 && selected.rowCount <= maxRows
    && safeInt(selected.rowCount) && safeInt(selected.runCount) && selected.runCount >= 1
    && selected.runCount <= selected.rowCount && HASH.test(selected.auditDigest)
    && HASH.test(selected.coverageDigest), 'archive_preview_invalid');
  decimal(selected.highwaterSeq, 'archive_preview_invalid');
  check(value.previousBatchId === null || typeof value.previousBatchId === 'string'
    && HASH.test(value.previousBatchId), 'archive_preview_invalid');
  return { sourceSnapshot, selection: selected, previousBatchId: value.previousBatchId };
}
function samePreview(expected, actual) {
  const a = expected.sourceSnapshot, b = actual.sourceSnapshot;
  return a.ledgerSchemaVersion === b.ledgerSchemaVersion && a.logicalDigest === b.logicalDigest
    && a.journalMode === b.journalMode
    && Object.keys(b.rowCounts).every(key => a.rowCounts[key] === b.rowCounts[key])
    && ['pageSize', 'pageCount', 'freelistCount'].every(key => a.pages[key] === b.pages[key])
    && expected.previousBatchId === actual.previousBatchId
    && Object.keys(actual.selection).every(key => expected.selection[key] === actual.selection[key]);
}

function readTransaction(path, code, fn) {
  safeFile(path, code);
  let db, active = false, result, failure = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('BEGIN'); active = true;
    result = fn(db);
  } catch (error) {
    failure = error instanceof AuditArchiveDatabaseError ? error : new AuditArchiveDatabaseError('archive_failed');
  } finally {
    if (active) try { db.exec('ROLLBACK'); } catch { failure ??= new AuditArchiveDatabaseError('archive_failed'); }
    try { db?.close(); } catch { failure ??= new AuditArchiveDatabaseError('archive_failed'); }
  }
  if (failure) throw failure;
  return result;
}

/** Read-only, complete bounded selection. An over-limit set is rejected, never silently cropped. */
export function previewAuditArchive(sourcePath, options = {}) {
  check(requiredOptions(options, ['backupPath', 'cutoffAt'], ['maxRows']), 'archive_options_invalid');
  const { backupPath, cutoffAt } = options, maxRows = optionLimit(options);
  check(safeInt(cutoffAt), 'archive_options_invalid');
  safeFile(backupPath, 'archive_backup_invalid');
  safeFile(sourcePath, 'archive_source_invalid');
  check(differentFiles(sourcePath, backupPath), 'archive_backup_invalid');
  return readTransaction(sourcePath, 'archive_source_invalid', db => {
    const sourceSnapshot = versionedSnapshot(db);
    backupEquivalent(sourceSnapshot, backupPath);
    const previousBatchId = metadataState(db, sourceSnapshot.ledgerSchemaVersion).tip;
    const chosen = selection(db, cutoffAt, maxRows);
    return Object.freeze({ sourceSnapshot, selection: chosen.public, previousBatchId });
  });
}

/** One exclusive transaction contains schema-4 admission, coverage and the audit deletion. */
export async function applyAuditArchive(sourcePath, options = {}) {
  try { assertSqliteWalRuntime(); } catch { fail('archive_runtime_unsupported'); }
  check(requiredOptions(options, ['backupPath', 'expectedPreview', 'batchId', 'archiveSha256',
    'archiveBytes', 'committedAt'], ['maxRows', 'onStage']), 'archive_options_invalid');
  const { backupPath, batchId, archiveSha256, archiveBytes, committedAt, onStage } = options;
  const maxRows = optionLimit(options), expected = checkedPreview(options.expectedPreview, maxRows);
  check(HASH.test(batchId) && HASH.test(archiveSha256) && safeInt(archiveBytes) && archiveBytes > 0
    && safeInt(committedAt) && (onStage === undefined || typeof onStage === 'function'), 'archive_options_invalid');
  safeFile(sourcePath, 'archive_source_invalid');
  safeFile(backupPath, 'archive_backup_invalid');
  check(differentFiles(sourcePath, backupPath), 'archive_backup_invalid');
  let db, active = false, commitAttempted = false, committed = false, result, failure = null;
  try {
    db = new DatabaseSync(sourcePath);
    let mode;
    try { mode = db.prepare('PRAGMA main.locking_mode=EXCLUSIVE').get()?.locking_mode; }
    catch { fail('archive_lock_failed'); }
    check(mode === 'exclusive', 'archive_lock_failed');
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
    try { db.exec('BEGIN EXCLUSIVE'); } catch { fail('archive_lock_failed'); }
    active = true;
    if (onStage) await onStage('locked');
    const before = versionedSnapshot(db);
    backupEquivalent(before, backupPath);
    const prior = metadataState(db, before.ledgerSchemaVersion);
    const chosen = selection(db, expected.selection.cutoffAt, maxRows);
    const current = { sourceSnapshot: before, selection: chosen.public, previousBatchId: prior.tip };
    check(samePreview(expected, current), 'archive_preview_stale');
    if (before.ledgerSchemaVersion === 4) {
      check(db.prepare('SELECT 1 FROM audit_archive_batches WHERE id=?').get(batchId) === undefined,
        'archive_batch_conflict');
    }
    const anchor = decimal(chosen.public.highwaterSeq, 'archive_content_invalid');
    const retainedBefore = retainedDigest(db, before.ledgerSchemaVersion,
      chosen.public.cutoffAt, anchor, batchId);
    if (before.ledgerSchemaVersion === 3) {
      for (const ddl of Object.values(AUDIT_ARCHIVE_TABLE_SQL)) db.exec(ddl);
      db.exec('PRAGMA user_version=4');
    }
    db.prepare('INSERT INTO audit_archive_batches VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      batchId, prior.tip, archiveSha256, archiveBytes, before.ledgerSchemaVersion,
      before.logicalDigest, chosen.public.cutoffAt, anchor, chosen.public.rowCount,
      chosen.public.auditDigest, committedAt);
    const insertCoverage = db.prepare('INSERT INTO audit_archive_coverage VALUES(?,?,?,?,?,?)');
    for (const item of chosen.coverage) insertCoverage.run(item.runKey, batchId,
      item.rowCount, item.minSeq, item.maxSeq, item.auditDigest);
    const deleted = db.prepare('DELETE FROM audit WHERE at<? AND seq<?')
      .run(BigInt(chosen.public.cutoffAt), anchor).changes;
    check(deleted === chosen.public.rowCount, 'archive_content_changed');
    const after = versionedSnapshot(db);
    const retainedAfter = retainedDigest(db, 4, chosen.public.cutoffAt, anchor, batchId);
    check(retainedAfter === retainedBefore && highwater(db) === anchor
      && countQuery(db, 'SELECT COUNT(*) AS count FROM audit WHERE at<? AND seq<?',
        BigInt(chosen.public.cutoffAt), anchor) === 0, 'archive_content_changed');
    const confirmed = metadataState(db, 4);
    check(confirmed.tip === batchId && confirmed.batchCount === prior.batchCount + 1
      && after.rowCounts.audit === before.rowCounts.audit - chosen.public.rowCount
      && after.rowCounts.audit_archive_batches === (before.rowCounts.audit_archive_batches ?? 0) + 1
      && after.rowCounts.audit_archive_coverage === (before.rowCounts.audit_archive_coverage ?? 0)
        + chosen.public.runCount
      && retainedTables.slice(0, 7).filter(table => table.name !== 'audit')
        .every(table => after.rowCounts[table.name] === before.rowCounts[table.name]),
    'archive_content_changed');
    if (onStage) await onStage('before-commit');
    commitAttempted = true;
    db.exec('COMMIT'); active = false; committed = true;
    if (onStage) await onStage('after-commit');
    result = Object.freeze({ batchId, archivedRows: chosen.public.rowCount,
      archivedRuns: chosen.public.runCount, coverageDigest: chosen.public.coverageDigest,
      before, after });
  } catch (error) {
    failure = commitAttempted ? new AuditArchiveDatabaseError('archive_uncertain')
      : error instanceof AuditArchiveDatabaseError ? error : new AuditArchiveDatabaseError('archive_failed');
  } finally {
    if (active) try { db.exec('ROLLBACK'); } catch { failure ??= new AuditArchiveDatabaseError('archive_failed'); }
    try { db?.close(); } catch { failure ??= new AuditArchiveDatabaseError(committed ? 'archive_uncertain' : 'archive_failed'); }
  }
  if (failure) throw failure;
  return result;
}

/** Verify the complete per-run archived selection before returning a bounded page. */
export function queryArchivedAudit(backupPath, options = {}) {
  check(requiredOptions(options, ['runKey', 'cutoffAt', 'highwaterSeq', 'expectedCoverage'],
    ['afterSeq', 'limit', 'includeDetails']), 'archive_options_invalid');
  const { runKey, cutoffAt, highwaterSeq, expectedCoverage } = options;
  const afterSeq = Object.hasOwn(options, 'afterSeq') ? options.afterSeq : null;
  const limit = Object.hasOwn(options, 'limit') ? options.limit : 20;
  const includeDetails = Object.hasOwn(options, 'includeDetails') ? options.includeDetails : false;
  check(typeof runKey === 'string' && runKey.length > 0 && runKey.length <= 1024
    && safeInt(cutoffAt) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50
    && typeof includeDetails === 'boolean' && (afterSeq === null || typeof afterSeq === 'string'),
  'archive_options_invalid');
  const anchor = decimal(highwaterSeq, 'archive_options_invalid');
  const after = afterSeq === null ? 0n : decimal(afterSeq, 'archive_options_invalid');
  check(after < anchor && exact(expectedCoverage, ['rowCount', 'minSeq', 'maxSeq', 'auditDigest'])
    && Number.isSafeInteger(expectedCoverage.rowCount) && expectedCoverage.rowCount >= 1
    && expectedCoverage.rowCount <= 10000 && HASH.test(expectedCoverage.auditDigest),
  'archive_options_invalid');
  const min = decimal(expectedCoverage.minSeq, 'archive_options_invalid');
  const max = decimal(expectedCoverage.maxSeq, 'archive_options_invalid');
  check(min > 0n && max >= min && max < anchor, 'archive_options_invalid');
  return readTransaction(backupPath, 'archive_backup_invalid', db => {
    versionedSnapshot(db);
    const hash = auditHash(), items = [];
    let count = 0, first = null, last = null, detailBytes = 0;
    for (const row of auditRows(db, 'run_key=? AND at<? AND seq<?',
      [runKey, BigInt(cutoffAt), anchor])) {
      check(validKeyBytes(row.raw_key) === runKey && typeof row.seq === 'bigint'
        && typeof row.at === 'bigint' && row.kind instanceof Uint8Array
        && row.details instanceof Uint8Array, 'archive_content_invalid');
      count++;
      check(count <= expectedCoverage.rowCount, 'archive_coverage_mismatch');
      first ??= row.seq; last = row.seq;
      auditRow(hash, row);
      if (row.seq <= after || items.length > limit) continue;
      const kindBytes = Buffer.from(row.kind), details = Buffer.from(row.details);
      const item = { seq: row.seq.toString(), at: row.at.toString(),
        detailsDigest: createHash('sha256').update(details).digest('hex') };
      if (kindBytes.length <= 128) {
        try {
          const kind = decoder.decode(kindBytes);
          if (Buffer.from(kind, 'utf8').equals(kindBytes)) item.kind = kind;
          else throw new TypeError('invalid UTF-8');
        } catch {
          item.kindDigest = createHash('sha256').update(kindBytes).digest('hex');
          item.kindBase64 = kindBytes.toString('base64');
        }
      } else {
        item.kindDigest = createHash('sha256').update(kindBytes).digest('hex');
        item.kindOmitted = 'size_limit';
      }
      if (includeDetails && items.length < limit) {
        if (details.length <= 8192 && detailBytes + details.length <= 32768) {
          item.detailsBase64 = details.toString('base64'); detailBytes += details.length;
        } else item.detailsOmitted = 'size_limit';
      }
      items.push(item);
    }
    check(count === expectedCoverage.rowCount && first === min && last === max
      && doneAuditHash(hash, count) === expectedCoverage.auditDigest, 'archive_coverage_mismatch');
    const page = items.slice(0, limit);
    const result = { items: page, nextCursor: items.length > limit ? page.at(-1).seq : null,
      verifiedRowCount: count, coverageVerified: true };
    // The IPC wrapper adds a small fixed envelope. Bound the actual serialized
    // page, including JSON escaping of arbitrary TEXT/control characters.
    const byteSize = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
    for (let i = page.length - 1; i >= 0 && byteSize() > 58000; i--) {
      if (Object.hasOwn(page[i], 'detailsBase64')) {
        delete page[i].detailsBase64;
        page[i].detailsOmitted = 'size_limit';
      }
    }
    while (byteSize() > 58000 && page.length > 1) page.pop();
    check(byteSize() <= 58000, 'archive_output_limit');
    result.nextCursor = items.length > page.length ? page.at(-1).seq : null;
    const freeze = value => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    return freeze(result);
  });
}
